import assert from "node:assert/strict";
import { test } from "node:test";
import * as path from "path";
import type * as Coc from "coc.nvim";
import { DEFAULT_SPLIT_COMMAND, applySettings, isSplitCommand, readSettings, resolveSheetPath } from "../src/settings";

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
            getConfiguration: () => ({ get: (key: string, fallback: unknown): unknown => (key in values ? values[key] : fallback) })
        },
        window: { showWarningMessage: async (m: string): Promise<void> => void warnings.push(m) }
    } as unknown as typeof Coc;
}

test("readSettings returns the defaults for an empty configuration", () => {
    assert.deepEqual(readSettings(fakeCoc({}, [])), { mode: "float", splitCommand: DEFAULT_SPLIT_COMMAND, stylesheets: [], linkTargets: false });
});

test("readSettings enables link targets only for true", () => {
    assert.equal(readSettings(fakeCoc({ linkTargets: true }, [])).linkTargets, true);
    assert.equal(readSettings(fakeCoc({ linkTargets: "yes" }, [])).linkTargets, false);
});

test("readSettings expands and resolves stylesheets, dropping empty and non-string entries", () => {
    const s = readSettings(fakeCoc({ "view.mode": "float", stylesheets: ["~/a.css", "rel/b.css", "", 3, "/abs/c.css"] }, []));
    assert.equal(s.mode, "float");
    assert.deepEqual(s.stylesheets, ["/home/u/a.css", path.resolve("/ws", "rel/b.css"), "/abs/c.css"]);
});

test("readSettings falls back from a bad split command with one warning", () => {
    const warnings: string[] = [];
    const coc = fakeCoc({ "view.splitCommand": "edit foo", "view.mode": "bogus" }, warnings);
    assert.deepEqual(readSettings(coc), { mode: "float", splitCommand: DEFAULT_SPLIT_COMMAND, stylesheets: [], linkTargets: false });
    readSettings(coc);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /'edit foo' is not a split command/);
    assert.equal(readSettings(fakeCoc({ "view.splitCommand": "topleft split" }, warnings)).splitCommand, "topleft split");
});

test("applySettings puts the user's stylesheets before the caller's and defaults the view", () => {
    const s = { mode: "split" as const, splitCommand: "tab split", stylesheets: ["/u.css"], linkTargets: true };
    assert.deepEqual(applySettings({ stylesheets: ["/caller.css"], lang: "java", view: { name: "n", mode: "float" } }, s), {
        stylesheets: ["/u.css", "/caller.css"],
        lang: "java",
        linkTargets: true,
        view: { name: "n", mode: "float", splitCommand: "tab split" }
    });
});
