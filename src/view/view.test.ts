import { test } from "node:test";
import * as assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Neovim } from "coc.nvim";
import { detectThemeKind, open } from "./index";
import type { RefreshRequest, RefreshResult } from "./index";
import { byteToCell } from "../common";
import { blendHex, type HlSpec, toExtmarks, toHlSpec, vimHiCommand } from "./convert";
import VIEW_LUA from "./view.lua";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adjacentAnchor, adjacentContext, adjacentLink, buildRequest, linkAt, mergeKeymap, resolveKey } from "./keys";
import { vimItems, vimNotify } from "./vim";
import type { Layout } from "../types";
import type { CodeHighlighter } from "../highlight";
import { renderOn } from "../render";

/** A fake nvim client that records every call and answers from a small script. */
class FakeNvim extends EventEmitter {
    calls: Array<{ kind: string; name: string; args: unknown[] }> = [];
    constructor(private readonly isNvim: boolean, private readonly width = 80) {
        super();
    }
    async createNamespace(name: string): Promise<number> {
        this.calls.push({ kind: "ns", name, args: [] });
        return name === "htmlview" ? 1 : 2;
    }
    async lua(_code: string, args: unknown[]): Promise<unknown> {
        const fn = args[2] as string;
        this.calls.push({ kind: "lua", name: fn, args: args[3] as unknown[] });
        const state = { winid: 1000, width: this.width, background: "dark" };
        return fn === "open" ? { bufnr: 7, ...state } : fn === "state" ? state : true;
    }
    async call(name: string, args: unknown[] = []): Promise<unknown> {
        this.calls.push({ kind: "call", name, args });
        const answers: Record<string, unknown> = { has: this.isNvim ? 1 : 0, bufwinid: -1, bufnr: 9, getbufvar: 0 };
        return answers[name] ?? 0;
    }
    async eval(expr: string): Promise<unknown> {
        this.calls.push({ kind: "eval", name: expr, args: [] });
        const answer =
            expr === "&background"
                ? "light"
                : expr.startsWith("get(filter")
                  ? -1
                  : expr.startsWith("bufwinid")
                    ? [1001, 60, "dark"]
                    : ["#101010", "#00ff00"];
        return answer;
    }
    async command(cmd: string): Promise<void> {
        this.calls.push({ kind: "command", name: cmd, args: [] });
    }
    fire(ev: Record<string, unknown>): void {
        this.emit("notification", "CocAutocmd", ["HtmlviewEvent", ev]);
    }
    named(kind: string, name: string): Array<{ kind: string; name: string; args: unknown[] }> {
        return this.calls.filter((c) => c.kind === kind && c.name === name);
    }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

const LAYOUT: Layout = {
    lines: ["héllo 世界 x", "[A] [B]", "see docs", "code a", "code b"],
    marks: [{ line: 0, startCol: 6, endCol: 10, group: "HtmlViewWide" }],
    links: [
        { line: 1, startCol: 0, endCol: 3, target: { kind: "context", contexts: "ctx", key: "a" } },
        { line: 1, startCol: 4, endCol: 7, target: { kind: "context", contexts: "ctx", key: "b" } },
        { line: 2, startCol: 4, endCol: 8, target: { kind: "url", href: "https://x.org" } },
        { line: 0, startCol: 6, endCol: 10, target: { kind: "anchor", id: "code" } },
    ],
    anchors: [
        { id: "top", line: 0 },
        { id: "code", line: 3 },
    ],
    codeRegions: [
        { startLine: 3, endLine: 3, startCol: 0, lang: "java", text: "code a" },
        { startLine: 4, endLine: 4, startCol: 0, lang: "java", text: "code b" },
    ],
};

test("view/convert: marks become byte extmarks (multibyte, wide, lineHl, invalid)", () => {
    const marks = toExtmarks(LAYOUT.lines, [
        { line: 0, startCol: 6, endCol: 10, group: "W" },
        { line: 0, startCol: 1, endCol: 2, group: "E", priority: 205 },
        { line: 0, startCol: 7, endCol: 7, group: "Empty" },
        { line: 0, startCol: 7, endCol: 8, group: "InsideWide" },
        { line: 3, startCol: 0, endCol: 0, group: "DiffAdd", lineHl: true, priority: 100 },
        { line: 99, startCol: 0, endCol: 1, group: "Gone" },
    ]);
    assert.deepEqual(marks, [
        [0, 7, 13, "W", 200, 0],
        [0, 1, 3, "E", 205, 0],
        [0, 7, 10, "InsideWide", 200, 0],
        [3, 0, 0, "DiffAdd", 100, 1],
    ]);
    assert.equal(byteToCell(LAYOUT.lines[0], 10), 8);
    assert.equal(byteToCell(LAYOUT.lines[0], 2), 1);
});

test("view/convert: GroupDef → nvim_set_hl spec, explicit false sets nocombine", () => {
    assert.deepEqual(toHlSpec({ name: "A", link: "Comment" }), { name: "A", link: "Comment" });
    assert.deepEqual(
        toHlSpec({
            name: "B",
            fg: { hex: "#112233" },
            bg: { hex: "#ffffff", alpha: 0.5 },
            sp: { group: "V", attr: "bg" },
            bold: true,
        }),
        {
            name: "B",
            attrs: { bold: true },
            colors: { fg: "#112233", bg: { hex: "#ffffff", alpha: 0.5 }, sp: { group: "V", attr: "bg" } },
        }
    );
    assert.deepEqual(toHlSpec({ name: "H1", bold: false, italic: true }), {
        name: "H1",
        attrs: { bold: false, italic: true, nocombine: true },
        colors: {},
    });
    assert.equal(blendHex("#ffffff", 0.5, "#000000"), "#808080");
    const live = { "V.bg": "#00ff00" };
    assert.equal(vimHiCommand(toHlSpec({ name: "A", link: "Comment" }), live, "#000000"), "hi def link A Comment");
    assert.equal(
        vimHiCommand(
            toHlSpec({ name: "B", fg: { group: "V", attr: "bg" }, bg: { hex: "#ffffff", alpha: 0.5 }, underline: false }),
            live,
            "#000000"
        ),
        "hi clear B | hi B guifg=#00ff00 guibg=#808080 gui=nocombine cterm=nocombine"
    );
});

/** Runs VIEW_LUA's M.define on a real headless nvim (skipped when there is none) and returns `nvim_get_hl` answers. */
/** Runs `body` in a headless Neovim with the view module loaded as `M`; the Lua table `res` comes back as JSON. */
function runViewLua<T>(body: string[]): T | undefined {
    const dir = mkdtempSync(join(tmpdir(), "htmlview-lua-"));
    const script = join(dir, "run.lua");
    const out = join(dir, "out.json");
    writeFileSync(
        script,
        [
            `local M = assert(loadstring(${JSON.stringify(VIEW_LUA)}))()`,
            "local res = {}",
            ...body,
            `vim.fn.writefile({ vim.json.encode(res) }, ${JSON.stringify(out)})`,
        ].join("\n")
    );
    const run = spawnSync("nvim", ["--headless", "--clean", "-l", script], { timeout: 10000 });
    let result: T | undefined;
    if (run.status === 0 && existsSync(out)) {
        result = JSON.parse(readFileSync(out, "utf8"));
    }
    rmSync(dir, { recursive: true, force: true });
    return result;
}

function defineInNvim(batches: HlSpec[][], user: string, names: string[]): Record<string, Record<string, unknown>> | undefined {
    return runViewLua([
        `vim.cmd(${JSON.stringify(user)})`,
        ...batches.map((b) => `M.define(vim.json.decode(${JSON.stringify(JSON.stringify(b))}))`),
        ...names.map((n) => `res[${JSON.stringify(n)}] = vim.api.nvim_get_hl(0, { name = ${JSON.stringify(n)} })`),
    ]);
}

const HAS_NVIM = spawnSync("nvim", ["--version"], { timeout: 5000 }).status === 0;

test("view/lua: a second define overrides stylesheet groups; variable links keep default (user :hi wins)", { skip: !HAS_NVIM }, () => {
    const first = [toHlSpec({ name: "HtmlViewH1", fg: { hex: "#111111" }, bold: true }), toHlSpec({ name: "HtmlViewVscodeX", link: "Comment" })];
    const second = [toHlSpec({ name: "HtmlViewH1", fg: { hex: "#222222" } }), toHlSpec({ name: "HtmlViewVscodeX", link: "String" })];
    const res = defineInNvim([first, second], "hi link HtmlViewVscodeUser Title", ["HtmlViewH1", "HtmlViewVscodeX"]);
    assert.ok(res !== undefined);
    // redefined in full: the new fg, and bold from the first definition is gone
    assert.deepEqual(res["HtmlViewH1"], { fg: 0x222222 });
    // a default link: the first definition (or a user :hi) stays
    assert.equal(res["HtmlViewVscodeX"].link, "Comment");
    const user = defineInNvim([first], "hi link HtmlViewVscodeX Title", ["HtmlViewVscodeX"]);
    assert.equal(user?.["HtmlViewVscodeX"].link, "Title");
});

test("view/lua: a float is borderless and shows the title in its window bar, also when reused", { skip: !HAS_NVIM }, () => {
    const spec = "name = 'x', reuse = true, mode = 'float', floatWidth = 0.8, floatHeight = 0.8, keys = {}";
    const res = runViewLua<{ border: unknown; first: string; second: string; width: number }>([
        `local a = M.open({ ${spec}, title = 'first', token = 'a' })`,
        "res.first = vim.wo[a.winid].winbar",
        `local o = M.open({ ${spec}, title = 'second', token = 'b' })`,
        "local cfg = vim.api.nvim_win_get_config(o.winid)",
        "res.border = cfg.border",
        "res.width = cfg.width",
        "res.second = vim.wo[o.winid].winbar",
    ]);
    assert.equal(res?.first, " first");
    assert.equal(res?.second, " second");
    assert.ok(res?.border === undefined || res.border === "none" || (Array.isArray(res.border) && res.border.every((c) => c === "")));
    assert.equal(res?.width, Math.floor(80 * 0.8));
});

test("view/lua: float text uses NormalFloat's background, a split is unchanged", { skip: !HAS_NVIM }, () => {
    const body = (mode: string): string[] => [
        "vim.cmd('hi Normal guibg=#101010 guifg=#cccccc | hi NormalFloat guibg=#303050')",
        "M.define({ { name = 'HtmlViewHostCanvas', link = 'Normal' } })",
        `local o = M.open({ name = 'x', reuse = false, mode = '${mode}', splitCommand = 'vsplit', floatWidth = 0.8, floatHeight = 0.8, title = 't', token = 'a', keys = {} })`,
        "vim.api.nvim_set_option_value('modifiable', true, { buf = o.bufnr })",
        "vim.api.nvim_buf_set_lines(o.bufnr, 0, -1, false, { 'hello', '' })",
        "vim.api.nvim_buf_set_extmark(o.bufnr, vim.api.nvim_create_namespace('t'), 0, 0, { end_col = 5, hl_group = 'HtmlViewHostCanvas' })",
        "vim.cmd('redraw')",
        "local pos = vim.fn.win_screenpos(o.winid)",
        "local row = pos[1] - 1 + (vim.api.nvim_win_get_config(o.winid).relative ~= '' and 1 or 0)",
        "res.ns = vim.api.nvim_get_hl_ns({ winid = o.winid })",
        "res.text = vim.fn.screenattr(row + 1, pos[2])",
        "res.blank = vim.fn.screenattr(row + 2, pos[2] + 3)",
        "res.global = vim.api.nvim_get_hl(0, { name = 'HtmlViewHostCanvas' }).link",
    ];
    type Probe = { ns: number; text: number; blank: number; global: string };
    const float = runViewLua<Probe>(body("float"));
    const split = runViewLua<Probe>(body("split"));
    assert.ok(float !== undefined && split !== undefined);
    // float: the canvas-grouped text has the cell attributes of the float's own blank cells (NormalFloat)
    assert.notEqual(float.ns, 0);
    assert.equal(float.text, float.blank);
    // split: global namespace, canvas group still Normal
    assert.equal(split.ns, 0);
    assert.notEqual(split.text, split.blank);
    assert.equal(float.global, "Normal");
});

test("view/lua: setting 'background' is watched like ColorScheme", { skip: !HAS_NVIM }, () => {
    const res = runViewLua<{ count: number }>([
        "local o = M.open({ name = 'x', reuse = false, mode = 'split', splitCommand = 'vsplit', title = 't', token = 'a', keys = {} })",
        "res.count = #vim.api.nvim_get_autocmds({ group = 'htmlview_' .. o.bufnr, event = 'OptionSet', pattern = 'background' })",
    ]);
    assert.equal(res?.count, 1);
});

test("view/lua: a live colour falls back when the linked group is undefined in the colorscheme", { skip: !HAS_NVIM }, () => {
    const specs = [
        toHlSpec({ name: "HtmlViewHtmlviewH", link: "@markup.heading.1" }),
        toHlSpec({ name: "HtmlViewH1", fg: { group: "HtmlViewHtmlviewH", attr: "fg", fallback: ["@markup.heading", "Title"] } }),
    ];
    const res = defineInNvim([specs], "hi Title guifg=#123456", ["HtmlViewH1"]);
    assert.deepEqual(res?.["HtmlViewH1"], { fg: 0x123456 });
    const live = { "Title.fg": "#123456" };
    assert.equal(vimHiCommand(specs[1], live, "#000000"), "hi clear HtmlViewH1 | hi HtmlViewH1 guifg=#123456");
});

test("view/keys: keymap merge and link/anchor/context resolution", () => {
    const keys = mergeKeymap({ q: false, x: "close" });
    assert.ok(!keys.some(([lhs]) => lhs === "q"));
    assert.ok(keys.some(([lhs, a]) => lhs === "x" && a === "close"));
    assert.ok(keys.some(([lhs, a]) => lhs === "]]" && a === "nextAnchor"));
    assert.equal(linkAt(LAYOUT, { line: 0, col: 10 })?.target.kind, "anchor");
    assert.equal(linkAt(LAYOUT, { line: 0, col: 2 }), undefined);
    assert.equal(adjacentLink(LAYOUT, { line: 1, col: 0 }, 1)?.startCol, 4);
    assert.equal(adjacentLink(LAYOUT, { line: 1, col: 0 }, -1)?.line, 0);
    assert.equal(adjacentAnchor(LAYOUT, 0, 1), 3);
    assert.equal(adjacentAnchor(LAYOUT, 0, -1), undefined);
    assert.deepEqual(adjacentContext(LAYOUT, 2, {}, 1), { contexts: "ctx", key: "b" });
    assert.deepEqual(adjacentContext(LAYOUT, 2, { ctx: "b" }, 1), { contexts: "ctx", key: "a" });
    // the selected title's box pushes it a line below the others: ]c must still visit every tab and wrap
    const offset: Layout = { ...LAYOUT, links: [
        { line: 0, startCol: 26, endCol: 43, target: { kind: "context", contexts: "tabs", key: "tab-1" } },
        { line: 0, startCol: 46, endCol: 55, target: { kind: "context", contexts: "tabs", key: "tab-2" } },
        { line: 1, startCol: 2, endCol: 23, target: { kind: "context", contexts: "tabs", key: "tab-0" } }
    ] };
    let at: string | undefined = "tab-0";
    const visited: string[] = [];
    for (let i = 0; i < 3; i++) {
        at = adjacentContext(offset, 1, { tabs: at! }, 1)?.key;
        visited.push(at!);
    }
    assert.deepEqual(visited, ["tab-1", "tab-2", "tab-0"]);
    assert.deepEqual(adjacentContext(offset, 1, { tabs: "tab-0" }, -1), { contexts: "tabs", key: "tab-2" });
    assert.deepEqual(resolveKey("follow", LAYOUT, { line: 0, col: 8 }, {}), { kind: "cursor", line: 3, col: 0 });
    assert.deepEqual(resolveKey("follow", LAYOUT, { line: 1, col: 5 }, {}), { kind: "activate", target: { kind: "context", contexts: "ctx", key: "b" } });
    assert.equal(resolveKey("openUrl", LAYOUT, { line: 2, col: 5 }, {}).kind, "url");
    assert.equal(resolveKey("openUrl", LAYOUT, { line: 1, col: 5 }, {}).kind, "none");
    assert.deepEqual(resolveKey("nextLink", LAYOUT, { line: 0, col: 0 }, {}), { kind: "cursor", line: 0, col: 7 });
    const req = buildRequest("resize", 0, "light", { a: "b" }, true);
    assert.deepEqual(req, { reason: "resize", width: 1, selected: { a: "b" }, themeKind: "light", virtual: true, target: undefined });
    assert.deepEqual(resolveKey("nextContext", LAYOUT, { line: 1, col: 0 }, {}), { kind: "activate", target: { kind: "context", contexts: "ctx", key: "b" } });
});

function hookRecorder(): { hook: (req: RefreshRequest) => RefreshResult; requests: RefreshRequest[] } {
    const requests: RefreshRequest[] = [];
    let selected: Record<string, string> = {};
    const hook = (req: RefreshRequest): RefreshResult => {
        requests.push(req);
        selected = req.target !== undefined && req.target.kind === "context" ? { ...selected, [req.target.contexts]: req.target.key } : selected;
        return { layout: LAYOUT, groups: [{ name: "HtmlViewWide", link: "Title" }], selected };
    };
    return { hook, requests };
}

test("view/open (nvim): refresh reasons, highlighter split, keys, close", async () => {
    const nvim = new FakeNvim(true);
    const { hook, requests } = hookRecorder();
    const hljsSeen: string[][] = [];
    const highlighter: CodeHighlighter = {
        hljs: (regions) => {
            hljsSeen.push(regions.map((r) => r.text));
            return regions.map((r) => ({
                line: r.startLine,
                startCol: 0,
                endCol: 4,
                group: "HtmlViewHljsKeyword",
                priority: 301,
            }));
        },
        treesitter: async () => ({ handled: [0] }),
    };
    const urls: string[] = [];
    const view = await open(nvim as unknown as Neovim, {
        mode: "float",
        name: "htmlview://rule/x",
        reuse: true,
        refresh: hook,
        highlighter,
        onOpenUrl: (t) => {
            urls.push(t.href);
        },
    });
    assert.equal(view.bufnr, 7);
    const openArgs = nvim.named("lua", "open")[0].args[0] as Record<string, unknown>;
    assert.equal(openArgs.mode, "float");
    assert.equal(openArgs.splitCommand, "botright vsplit");
    assert.equal(openArgs.title, "htmlview://rule/x");
    assert.deepEqual(requests[0], { reason: "open", width: 80, selected: {}, themeKind: "dark", virtual: true, target: undefined });
    const update = nvim.named("lua", "update")[0].args;
    assert.deepEqual(update.slice(0, 3), [7, 1, 2]);
    assert.deepEqual(update[4], [{ name: "HtmlViewWide", link: "Title" }]);
    assert.deepEqual(update[5], [[0, 7, 13, "HtmlViewWide", 200, 0]]);
    assert.deepEqual(hljsSeen, [["code b"]]);
    assert.deepEqual(nvim.named("lua", "marks")[0].args, [7, 2, [[4, 0, 4, "HtmlViewHljsKeyword", 301, 0]]]);

    const token = openArgs.token as string;
    nvim.fire({ token, kind: "key", action: "follow", line: 1, col: 5 });
    await tick();
    assert.deepEqual(requests[1].target, { kind: "context", contexts: "ctx", key: "b" });
    assert.equal(requests[1].reason, "context");
    nvim.fire({ token, kind: "resize", winid: 1000, width: 80, background: "dark" });
    nvim.fire({ token, kind: "resize", winid: 1000, width: 60, background: "dark" });
    nvim.fire({ token: "other", kind: "colorscheme", width: 50, background: "light" });
    await tick();
    assert.equal(requests.length, 3);
    assert.deepEqual([requests[2].reason, requests[2].width, requests[2].selected], ["resize", 60, { ctx: "b" }]);
    nvim.fire({ token, kind: "colorscheme", winid: 1000, width: 60, background: "light" });
    nvim.fire({ token, kind: "key", action: "openUrl", line: 2, col: 5 });
    nvim.fire({ token, kind: "key", action: "nextAnchor", line: 0, col: 0 });
    await tick();
    assert.deepEqual([requests[3].reason, requests[3].themeKind], ["colorscheme", "light"]);
    assert.deepEqual(urls, ["https://x.org"]);
    assert.deepEqual(nvim.named("lua", "cursor")[0].args, [7, 3, 0]);

    nvim.fire({ token, kind: "closed" });
    await view.closed;
    assert.equal(view.winid, -1);
    assert.equal(nvim.listenerCount("notification"), 0);
    await view.close();
    assert.equal(nvim.named("lua", "close").length, 0);
});

test("view/open (nvim): a View reusing the buffer makes the older View's in-flight refresh apply nothing", async () => {
    const nvim = new FakeNvim(true);
    let release: () => void = () => undefined;
    const slow: CodeHighlighter = {
        hljs: (regions) => regions.map((r) => ({ line: r.startLine, startCol: 0, endCol: 4, group: "HtmlViewHljsKeyword", priority: 301 })),
        treesitter: () => new Promise((resolve) => (release = () => resolve({ handled: [] }))),
    };
    const first = open(nvim as unknown as Neovim, { mode: "float", name: "x", reuse: true, refresh: hookRecorder().hook, highlighter: slow });
    await tick();
    await open(nvim as unknown as Neovim, { mode: "float", name: "x", reuse: true, refresh: hookRecorder().hook });
    release();
    await first;
    assert.equal(nvim.named("lua", "update").length, 2);
    assert.deepEqual(nvim.named("lua", "marks"), []);
});

test("view/open (nvim): close() calls Lua close once and resolves closed", async () => {
    const nvim = new FakeNvim(true);
    const view = await open(nvim as unknown as Neovim, {
        mode: "split",
        name: "n",
        reuse: false,
        refresh: hookRecorder().hook,
        splitCommand: "topleft split",
    });
    assert.equal((nvim.named("lua", "open")[0].args[0] as Record<string, unknown>).splitCommand, "topleft split");
    await view.close();
    await view.close();
    await view.closed;
    assert.deepEqual(
        nvim.named("lua", "close").map((c) => c.args),
        [[7]]
    );
});

test("view/open (vim fallback): split, text properties through coc, hljs for every region", async () => {
    const nvim = new FakeNvim(false);
    const seen: number[] = [];
    const highlighter: CodeHighlighter = {
        hljs: (regions) => {
            seen.push(regions.length);
            return [];
        },
        treesitter: async () => {
            throw new Error("treesitter must not run on Vim");
        },
    };
    const { hook, requests } = hookRecorder();
    const view = await open(nvim as unknown as Neovim, { mode: "float", name: "v", reuse: false, refresh: hook, highlighter });
    assert.equal(view.bufnr, 9);
    assert.ok(nvim.calls.some((c) => c.kind === "command" && c.name.startsWith("botright vsplit | enew")));
    assert.equal(requests[0].width, 60);
    assert.deepEqual(nvim.named("call", "coc#highlight#set")[0].args, [9, "htmlview", [["HtmlViewWide", 0, 7, 13, 1]], 200]);
    assert.ok(nvim.calls.some((c) => c.kind === "command" && c.name.includes("hi def link HtmlViewWide Title")));
    assert.deepEqual(seen, [2]);
    assert.deepEqual(vimItems([[2, 0, 0, "DiffAdd", 100, 1]]), [["DiffAdd", 2, 0, -1, 1]]);
    assert.equal(
        vimNotify("t", "closed"),
        "call coc#rpc#notify('CocAutocmd', ['HtmlviewEvent', {'token': 't', 'kind': 'closed'}])"
    );
    assert.equal(await detectThemeKind(nvim as unknown as Neovim), "light");
});

test("render: stylesheet paths are parsed once per render, not per resize", async () => {
    const nvim = new FakeNvim(true);
    const dir = mkdtempSync(join(tmpdir(), "htmlview-sheets-"));
    const sheet = join(dir, "a.css");
    writeFileSync(sheet, "p { color: red }");
    const logged: string[] = [];
    await renderOn(nvim as unknown as Neovim, "<p>text</p>", { stylesheets: [sheet, join(dir, "missing.css")], view: { mode: "split", name: "r", reuse: false } }, { log: (m) => logged.push(m) });
    const token = (nvim.named("lua", "open")[0].args[0] as Record<string, unknown>).token as string;
    nvim.fire({ token, kind: "resize", winid: 1000, width: 60, background: "dark" });
    nvim.fire({ token, kind: "resize", winid: 1000, width: 50, background: "dark" });
    await tick();
    assert.equal(nvim.named("lua", "update").length, 3);
    assert.equal(logged.length, 1);
    assert.ok(logged[0].includes("missing.css"));
    rmSync(dir, { recursive: true });
});

test("view/lua: view.lua is valid Lua", (t) => {
    const check = spawnSync("luac", ["-p", "-"], { input: VIEW_LUA, encoding: "utf8" });
    if (check.error !== undefined) {
        t.skip("luac not installed");
    } else {
        assert.equal(check.status, 0, check.stderr);
    }
});
