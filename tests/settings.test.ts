import assert from "node:assert/strict";
import { test } from "node:test";
import * as path from "path";
import type * as Coc from "coc.nvim";
import { DEFAULT_SPLIT_COMMAND, applySettings, isSplitCommand, readSettings, resolveSheetPath, settingSheets } from "../src/settings";

test("isSplitCommand accepts split-like commands", () => {
    for (const c of ["botright vsplit", "topleft split", "tab split", "vertical 80split", "vert new", "aboveleft 30 sp", "belowright vnew", "to vs", "split", "tab vert bo vsplit", "  botright vsplit "]) {
        assert.equal(isSplitCommand(c), true, c);
    }
});

test("isSplitCommand rejects anything else", () => {
    for (const c of ["", "edit foo", "botright vsplit | !rm -rf ~", "vsplit; q", "!ls", "call system('x')", "botright", "vsplitx", "tab", "botright vsplit foo", "foo vsplit"]) {
        assert.equal(isSplitCommand(c), false, c);
    }
});

test("resolveSheetPath resolves relative paths against the root", () => {
    assert.equal(resolveSheetPath("a/b.css", "/ws"), path.resolve("/ws", "a/b.css"));
    assert.equal(resolveSheetPath("/abs/b.css", "/ws"), "/abs/b.css");
    assert.equal(resolveSheetPath("b.css", ""), "b.css");
});

function fakeCoc(values: Record<string, unknown>, warnings: string[]): typeof Coc {
    return {
        workspace: {
            root: "/ws",
            expand: (f: string): string => f.replace(/^~/, "/home/u"),
            getConfiguration: () => ({
                get: (key: string, fallback: unknown): unknown => (key in values ? values[key] : fallback),
                // the user level is `values[key]`, the workspace level `values["workspace:" + key]`, the default level `values["default:" + key]`
                inspect: (key: string) => ({ key, defaultValue: values[`default:${key}`], globalValue: values[key], workspaceValue: values[`workspace:${key}`] })
            })
        },
        window: { showWarningMessage: async (m: string): Promise<void> => void warnings.push(m) }
    } as unknown as typeof Coc;
}

test("readSettings returns the defaults for an empty configuration", () => {
    assert.deepEqual(readSettings(fakeCoc({}, []), "/cfg"), { mode: "float", splitCommand: DEFAULT_SPLIT_COMMAND, stylesheets: [], linkTargets: false });
});

test("readSettings enables link targets only for true", () => {
    assert.equal(readSettings(fakeCoc({ linkTargets: true }, []), "/cfg").linkTargets, true);
    assert.equal(readSettings(fakeCoc({ linkTargets: "yes" }, []), "/cfg").linkTargets, false);
});

test("readSettings expands and resolves stylesheets, dropping empty and non-string entries", () => {
    const s = readSettings(fakeCoc({ "view.mode": "float", stylesheets: ["~/a.css", "rel/b.css", "", 3, "/abs/c.css"] }, []), "/cfg");
    assert.equal(s.mode, "float");
    assert.deepEqual(s.stylesheets, ["/home/u/a.css", path.resolve("/cfg", "rel/b.css"), "/abs/c.css"]);
});

test("readSettings: user level against the coc config folder, then the workspace level against the root; the default level is ignored", () => {
    const s = readSettings(fakeCoc({ stylesheets: ["u.css"], "workspace:stylesheets": ["w.css"], "default:stylesheets": ["/from/another/extension.css"] }, []), "/cfg");
    assert.deepEqual(s.stylesheets, [path.resolve("/cfg", "u.css"), path.resolve("/ws", "w.css")]);
});

test("settingSheets prefers the workspace folder level over the workspace level", () => {
    const sheets = settingSheets({ workspaceValue: ["w.css"], workspaceFolderValue: ["f.css"] }, { user: "/cfg", workspace: "/ws" }, (f: string): string => f);
    assert.deepEqual(sheets, [path.resolve("/ws", "f.css")]);
});

test("readSettings falls back from a bad split command with one warning", () => {
    const warnings: string[] = [];
    const coc = fakeCoc({ "view.splitCommand": "edit foo", "view.mode": "bogus" }, warnings);
    assert.deepEqual(readSettings(coc, "/cfg"), { mode: "float", splitCommand: DEFAULT_SPLIT_COMMAND, stylesheets: [], linkTargets: false });
    readSettings(coc, "/cfg");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /'edit foo' is not a split command/);
    assert.equal(readSettings(fakeCoc({ "view.splitCommand": "topleft split" }, warnings), "/cfg").splitCommand, "topleft split");
});

test("applySettings puts the user's stylesheets before the caller's and defaults the view", () => {
    const s = { mode: "split" as const, splitCommand: "tab split", stylesheets: ["/u.css"], linkTargets: true };
    assert.deepEqual(applySettings({ stylesheets: ["/caller.css"], lang: "java", view: { name: "n", mode: "float" } }, s, "/htmlview", (f: string): string => f), {
        stylesheets: ["/u.css", "/caller.css"],
        lang: "java",
        linkTargets: true,
        view: { name: "n", mode: "float", splitCommand: "tab split" }
    });
});

test("applySettings resolves the caller's relative sheets against its root, else coc-htmlview's folder", () => {
    const s = { mode: "float" as const, splitCommand: DEFAULT_SPLIT_COMMAND, stylesheets: [], linkTargets: false };
    const expand = (f: string): string => f.replace(/^~/, "/home/u");
    const own = applySettings({ root: "/ext", stylesheets: ["styles/a.css", "~/b.css", "/abs/c.css"], view: { name: "n" } }, s, "/htmlview", expand);
    assert.deepEqual(own.stylesheets, [path.resolve("/ext", "styles/a.css"), "/home/u/b.css", "/abs/c.css"]);
    assert.ok(!("root" in own), "root is consumed, not passed down");
    const fallback = applySettings({ stylesheets: ["styles/a.css"], view: { name: "n" } }, s, "/htmlview", expand);
    assert.deepEqual(fallback.stylesheets, [path.resolve("/htmlview", "styles/a.css")]);
});
