import { test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import hljs from "highlight.js";
import type { Neovim } from "coc.nvim";
import { MarkPriority } from "../../src/common";
import type { CodeRegion, Mark } from "../../src/types";
import { buildLanguageTable, createHighlighter, defaultLanguageTable, highlightRegions, treesitterRegions } from "../../src/highlight/index";
import { scanHljsHtml } from "../../src/highlight/hljs";
import { resolveLanguage } from "../../src/highlight/languages";
import { buildJobs, luaArgs } from "../../src/highlight/treesitter";
import TREESITTER_LUA from "../../src/highlight/treesitter.lua";

const groupFor = (cls: string): string | undefined => (cls.startsWith("hljs-") ? `G_${cls.slice(5)}` : undefined);

function region(lang: string, text: string, startLine = 0, startCol = 0): CodeRegion {
    return { startLine, endLine: startLine + text.split("\n").length - 1, startCol, lang, text };
}

function find(marks: Mark[], group: string): Mark[] {
    return marks.filter((m: Mark) => m.group === group);
}

test("highlight: java keywords and strings at cell columns with region offsets", () => {
    const marks = highlightRegions([region("java", 'public class A {\n  String s = "x";\n}', 5, 4)], defaultLanguageTable, groupFor);
    const kw = find(marks, "G_keyword");
    assert.deepEqual(kw[0], { line: 5, startCol: 4, endCol: 10, group: "G_keyword", priority: MarkPriority.code + 1 });
    assert.deepEqual(find(marks, "G_string")[0], { line: 6, startCol: 4 + 13, endCol: 4 + 16, group: "G_string", priority: MarkPriority.code + 1 });
    for (const m of marks) {
        assert.ok(m.priority !== undefined && m.priority > MarkPriority.code && m.priority < MarkPriority.ui);
    }
});

test("highlight: columns after a multibyte and a wide character are cells, not bytes or UTF-16 units", () => {
    const marks = highlightRegions([region("java", 'String é = "日本"; int x;', 0, 2)], defaultLanguageTable, groupFor);
    // "String é = " is 11 cells; "日本" quoted is 6 cells wide; then "; " -> int at 11 + 6 + 2 = 19
    assert.deepEqual(find(marks, "G_string").map((m: Mark) => [m.startCol, m.endCol]), [[2 + 11, 2 + 17]]);
    const types = find(marks, "G_type").map((m: Mark) => [m.startCol, m.endCol]);
    assert.ok(types.some((c: number[]) => c[0] === 2 + 19 && c[1] === 2 + 22), JSON.stringify(marks));
});

test("highlight: python multi-line string is split per line, continuation lines start at startCol", () => {
    const marks = highlightRegions([region("py", 'def f():\n    s = """a\nbb"""\n', 1, 3)], defaultLanguageTable, groupFor);
    assert.deepEqual(find(marks, "G_keyword")[0], { line: 1, startCol: 3, endCol: 6, group: "G_keyword", priority: MarkPriority.code + 1 });
    const str = find(marks, "G_string").map((m: Mark) => [m.line, m.startCol, m.endCol]);
    assert.deepEqual(str, [
        [2, 3 + 8, 3 + 12],
        [3, 3, 3 + 5],
    ]);
});

test("highlight: xml nested scopes get deeper priorities and decoded entity widths", () => {
    const marks = highlightRegions([region("xml", '<a href="x">&amp;</a>')], defaultLanguageTable, groupFor);
    const tag = find(marks, "G_tag")[0];
    const name = find(marks, "G_name")[0];
    assert.deepEqual([tag.startCol, tag.endCol, tag.priority], [0, 12, MarkPriority.code + 1]);
    assert.deepEqual([name.startCol, name.endCol, name.priority], [1, 2, MarkPriority.code + 2]);
    assert.deepEqual(find(marks, "G_attr").map((m: Mark) => [m.startCol, m.endCol]), [[3, 7]]);
    // "&amp;" in the source is 5 cells; the closing tag starts right after it
    assert.deepEqual(find(marks, "G_tag")[1].startCol, 17);
});

test("highlight: unknown or empty language gives no marks and does not throw", () => {
    assert.deepEqual(highlightRegions([region("nosuchlang", "int x;"), region("", "int x;")], defaultLanguageTable, groupFor), []);
    assert.deepEqual(highlightRegions([region("secrets", "key = 'abc'")], defaultLanguageTable, groupFor), []);
});

test("highlight: classes without a group are skipped", () => {
    assert.deepEqual(highlightRegions([region("java", "class A {}")], defaultLanguageTable, () => undefined), []);
});

test("highlight: a failing region does not affect the others", () => {
    const boom = (cls: string): string | undefined => {
        if (cls === "hljs-string") {
            throw new Error("boom");
        }
        return groupFor(cls);
    };
    const marks = highlightRegions([region("java", 'String s = "x";', 0), region("py", "def f(): pass", 2)], defaultLanguageTable, boom);
    assert.equal(marks.filter((m: Mark) => m.line === 0).length, 0);
    assert.ok(find(marks, "G_keyword").some((m: Mark) => m.line === 2));
});

test("highlight: scanner decodes entities and nests scopes", () => {
    const { text, scopes } = scanHljsHtml('<span class="a b">&lt;<span class="c">x</span></span>&#x27;');
    assert.equal(text, "<x'");
    assert.deepEqual(scopes.map((s) => [s.classes, s.start, s.end, s.depth]), [
        [["c"], 1, 2, 2],
        [["a", "b"], 0, 2, 1],
    ]);
});

test("highlight: language table has no dangling entries", () => {
    const required = ["javascript", "js", "jsx", "mjs", "typescript", "ts", "tsx", "python", "py", "java", "kotlin", "kt", "csharp", "cs", "c#",
        "c", "cpp", "c++", "cc", "h", "hpp", "objectivec", "objc", "go", "golang", "rust", "rs", "ruby", "rb", "php", "scala", "swift", "dart",
        "shell", "sh", "bash", "zsh", "powershell", "ps1", "sql", "html", "htm", "xml", "svg", "css", "scss", "less", "json", "jsonc", "yaml",
        "yml", "toml", "ini", "dockerfile", "docker", "hcl", "terraform", "tf", "lua", "vim", "viml", "markdown", "md", "diff", "patch",
        "makefile", "make", "graphql", "proto", "protobuf", "r", "perl", "haskell", "hs", "elixir", "ex", "erlang", "clojure", "clj",
        "groovy", "gradle", "actionscript", "vb", "vbnet", "cobol", "bicep"];
    for (const key of required) {
        assert.ok(Object.prototype.hasOwnProperty.call(defaultLanguageTable, key), key);
    }
    for (const [key, entry] of Object.entries(defaultLanguageTable)) {
        assert.equal(key, key.toLowerCase());
        if (entry.hljs !== undefined) {
            assert.ok(hljs.getLanguage(entry.hljs) !== undefined, `${key} -> hljs ${entry.hljs}`);
        }
        if (entry.treesitter !== undefined) {
            assert.match(entry.treesitter, /^[a-z][a-z0-9_]*$/, `${key} -> treesitter ${entry.treesitter}`);
        }
    }
    assert.equal(defaultLanguageTable.terraform.treesitter, "hcl");
});

test("highlight: generic resolution lowercases, falls back to the name itself and gives nothing for empty", () => {
    assert.deepEqual(resolveLanguage("JS", defaultLanguageTable), { treesitter: "javascript", hljs: "javascript" });
    assert.deepEqual(resolveLanguage("C#", defaultLanguageTable), { treesitter: "c_sharp", hljs: "csharp" });
    assert.deepEqual(resolveLanguage("sh", defaultLanguageTable), resolveLanguage("bash", defaultLanguageTable));
    assert.deepEqual(resolveLanguage("nosuch", defaultLanguageTable), { treesitter: "nosuch", hljs: "nosuch" });
    assert.deepEqual(resolveLanguage("", defaultLanguageTable), {});
});

test("highlight: the languages option extends and overrides the table (alias string or engine ids)", () => {
    const table = buildLanguageTable(defaultLanguageTable, { Web: "html", secrets: "", fancy: { treesitter: "fancy_ts" }, js: { hljs: "typescript" }, a: "b", b: "a", c1: "c2", c2: "ts", ghost: "unknownlang" });
    assert.deepEqual(resolveLanguage("web", table), resolveLanguage("html", defaultLanguageTable));
    assert.deepEqual(resolveLanguage("secrets", table), {});
    assert.deepEqual(resolveLanguage("fancy", table), { treesitter: "fancy_ts" });
    assert.deepEqual(resolveLanguage("js", table), { hljs: "typescript" });
    assert.deepEqual(resolveLanguage("a", table), {});
    assert.deepEqual(resolveLanguage("c1", table), resolveLanguage("typescript", defaultLanguageTable));
    assert.deepEqual(resolveLanguage("ghost", table), { treesitter: "unknownlang", hljs: "unknownlang" });
    assert.notEqual(table, defaultLanguageTable);
    assert.deepEqual(resolveLanguage("js", defaultLanguageTable), { treesitter: "javascript", hljs: "javascript" });
});

test("highlight: treesitter jobs and the nvim.lua argument shape", () => {
    const regions = [region("java", "class A {}", 3, 2), region("", "x"), region("secrets", "y"), region("tsql", "SELECT 1", 9)];
    const jobs = buildJobs(regions, buildLanguageTable(defaultLanguageTable, { secrets: "", tsql: "sql", rpg: "" }));
    assert.deepEqual(jobs, [
        { index: 0, lang: "java", text: "class A {}", startLine: 3, startCol: 2 },
        { index: 3, lang: "sql", text: "SELECT 1", startLine: 9, startCol: 0 },
    ]);
    assert.deepEqual(luaArgs(4, 7, jobs), [4, 7, MarkPriority.code, jobs]);
});

test("highlight: treesitterRegions makes one batched call and filters the result", async () => {
    const calls: unknown[][] = [];
    const nvim = { lua: async (code: string, args: unknown[]) => { calls.push([code, args]); return [3, 0, 42, "x"]; } } as unknown as Neovim;
    const regions = [region("java", "class A {}"), region("", "x"), region("rpg", "y"), region("go", "package m")];
    const result = await treesitterRegions(nvim, 1, 2, regions, defaultLanguageTable);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], TREESITTER_LUA);
    assert.deepEqual(result, { handled: [3, 0] });
});

test("highlight: treesitterRegions never throws and skips the call with no jobs", async () => {
    let called = 0;
    const failing = { lua: async () => { called += 1; throw new Error("vim"); } } as unknown as Neovim;
    assert.deepEqual(await treesitterRegions(failing, 1, 2, [region("java", "x")], defaultLanguageTable), { handled: [] });
    assert.deepEqual(await treesitterRegions(failing, 1, 2, [region("", "x")], defaultLanguageTable), { handled: [] });
    const empty = { lua: async () => ({}) } as unknown as Neovim;
    assert.deepEqual(await treesitterRegions(empty, 1, 2, [region("java", "x")], defaultLanguageTable), { handled: [] });
    assert.equal(called, 1);
});

test("highlight: treesitter Lua chunk is valid Lua", (t) => {
    assert.ok(!TREESITTER_LUA.includes("${"));
    const check = spawnSync("luac", ["-p", "-"], { input: TREESITTER_LUA, encoding: "utf8" });
    if (check.error !== undefined) {
        t.skip("luac not installed");
    } else {
        assert.equal(check.status, 0, check.stderr);
    }
});

test("highlight: createHighlighter binds the table and lookup", async () => {
    const h = createHighlighter(defaultLanguageTable, groupFor);
    assert.deepEqual(h.hljs([region("java", "class A {}")]), highlightRegions([region("java", "class A {}")], defaultLanguageTable, groupFor));
    const nvim = { lua: async () => [0] } as unknown as Neovim;
    assert.deepEqual(await h.treesitter(nvim, 1, 2, [region("java", "class A {}")]), { handled: [0] });
});
