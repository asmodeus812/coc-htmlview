// Engine decorations: toDecorations / flattenVirtual, activation through the controller, and a headless nvim check.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Neovim } from "coc.nvim";
import { open } from "./index";
import type { RefreshRequest, RefreshResult } from "./index";
import { flattenVirtual, toDecorations, toHlSpec } from "./convert";
import type { Layout } from "../types";
import VIEW_LUA from "./view.lua";

const BASE: Layout = {
    lines: ["世界 word", "  item", "code"],
    marks: [{ line: 0, startCol: 5, endCol: 9, group: "G" }],
    links: [{ line: 0, startCol: 5, endCol: 9, target: { kind: "url", href: "https://x.org" } }],
    anchors: [{ id: "c", line: 2 }],
    codeRegions: [{ startLine: 2, endLine: 2, startCol: 0, lang: "java", text: "code" }],
    virtText: [
        { line: 0, col: 9, pos: "inline", role: "link-target", chunks: [{ text: " 🔗 u", groups: ["HtmlViewHostLinkUrl"] }] },
        { line: 1, col: 0, pos: "overlay", role: "marker", chunks: [{ text: "• ", groups: ["M"] }] },
        { line: 2, col: 20, pos: "overlay", role: "pseudo", chunks: [{ text: "x", groups: [] }] },
    ],
    virtLines: [{ line: 1, above: false, role: "border", lines: [[{ text: "---", groups: ["B"] }]] }],
};

test("view/convert: toDecorations gives byte columns, a window column past the line end, virt lines and conceals", () => {
    const d = toDecorations({ ...BASE, conceals: [{ line: 0, startCol: 0, endCol: 2, char: "" }] });
    // "世界 word": cell 9 is byte 11 (two 3-byte chars + 5)
    assert.deepEqual(d.virt[0], [0, 11, "inline", [[" 🔗 u", ["HtmlViewHostLinkUrl"]]], 200, -1, "link-target"].map((x, i) => (i === 4 ? d.virt[0][4] : x)));
    assert.equal(d.virt[1][5], -1);
    assert.equal(d.virt[2][5], 20);
    assert.deepEqual(d.virtLines, [[1, 0, [[["---", ["B"]]]]]]);
    assert.deepEqual(d.conceals, [[0, 0, 3, ""]]);
});

test("view/convert: flattenVirtual splices text, replaces blank overlays, moves items below virtual lines", () => {
    const flat = flattenVirtual(BASE);
    assert.equal(flat.lines[0], "世界 word 🔗 u");
    assert.equal(flat.lines[1], "• item");
    assert.equal(flat.lines[2], "---");
    assert.equal(flat.lines[3].startsWith("code"), true);
    assert.deepEqual(flat.links[0], BASE.links[0], "a link before the splice is unchanged");
    assert.equal(flat.anchors[0].line, 3);
    assert.equal(flat.codeRegions[0].startLine, 3);
    assert.ok(flat.marks.some((m) => m.group === "HtmlViewHostLinkUrl" && m.line === 0 && m.startCol === 9));
    const shifted = flattenVirtual({ ...BASE, virtLines: [], virtText: [{ line: 0, col: 5, pos: "inline", role: "pseudo", chunks: [{ text: "++", groups: ["P"] }] }] });
    assert.equal(shifted.lines[0], "世界 ++word");
    assert.deepEqual([shifted.marks[0].startCol, shifted.marks[0].endCol], [7, 11]);
    assert.deepEqual([shifted.links[0].startCol, shifted.links[0].endCol], [7, 11]);
});

test("view/convert: toHlSpec keeps the fallback chain of a link", () => {
    assert.deepEqual(toHlSpec({ name: "A", link: "@markup", fallback: ["Title"] }), { name: "A", link: "@markup", fallback: ["Title"] });
});

class FakeNvim extends EventEmitter {
    calls: Array<{ name: string; args: unknown[] }> = [];
    constructor(private readonly isNvim: boolean) {
        super();
    }
    async createNamespace(name: string): Promise<number> {
        return name === "htmlview" ? 1 : 2;
    }
    async lua(_c: string, args: unknown[]): Promise<unknown> {
        const fn = args[2] as string;
        this.calls.push({ name: fn, args: args[3] as unknown[] });
        const state = { winid: 1000, width: 80, background: "dark" };
        return fn === "open" ? { bufnr: 7, ...state } : fn === "state" ? state : true;
    }
    async call(name: string, args: unknown[] = []): Promise<unknown> {
        this.calls.push({ name: `call:${name}`, args });
        return name === "has" ? (this.isNvim ? 1 : 0) : name === "bufnr" ? 9 : name === "bufwinid" ? -1 : 0;
    }
    async eval(expr: string): Promise<unknown> {
        return expr === "&background" ? "dark" : expr.startsWith("bufwinid") ? [1001, 60, "dark"] : expr.startsWith("get(filter") ? -1 : ["#101010", "#00ff00"];
    }
    async command(): Promise<void> {}
    fire(ev: Record<string, unknown>): void {
        this.emit("notification", "CocAutocmd", ["HtmlviewEvent", ev]);
    }
}
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

const CTX: Layout = {
    lines: ["[A] [B]"],
    marks: [],
    links: [
        { line: 0, startCol: 0, endCol: 3, target: { kind: "context", contexts: "g", key: "a" } },
        { line: 0, startCol: 4, endCol: 7, target: { kind: "context", contexts: "g", key: "b" } },
    ],
    anchors: [],
    codeRegions: [],
};

test("view/controller: <CR> and ]c activate the context target; result.selected is kept; Vim gets buffer text", async () => {
    const nvim = new FakeNvim(true);
    const requests: RefreshRequest[] = [];
    const hook = (req: RefreshRequest): RefreshResult => {
        requests.push(req);
        const selected = req.target?.kind === "context" ? { [req.target.contexts]: req.target.key } : {};
        return { layout: CTX, groups: [], selected };
    };
    const view = await open(nvim as unknown as Neovim, { mode: "split", name: "n", reuse: false, refresh: hook });
    const token = (nvim.calls.find((c) => c.name === "open")?.args[0] as Record<string, unknown>).token as string;
    nvim.fire({ token, kind: "key", action: "follow", line: 0, col: 5 });
    await tick();
    assert.deepEqual([requests[1].reason, requests[1].target], ["context", { kind: "context", contexts: "g", key: "b" }]);
    assert.equal(requests[1].virtual, true);
    nvim.fire({ token, kind: "key", action: "nextContext", line: 0, col: 0 });
    await tick();
    assert.deepEqual(requests[2].target, { kind: "context", contexts: "g", key: "a" }, "stored selection b cycles to a");
    const update = nvim.calls.filter((c) => c.name === "update")[0].args;
    assert.deepEqual(update[6], { virt: [], virtLines: [], conceals: [] });
    await view.close();

    const vim = new FakeNvim(false);
    const vimHook = (): RefreshResult => ({ layout: BASE, groups: [] });
    await open(vim as unknown as Neovim, { mode: "split", name: "v", reuse: false, refresh: vimHook });
    const set = vim.calls.find((c) => c.name === "call:setbufline");
    assert.ok((set?.args[2] as string[]).some((l) => l.includes(" 🔗 ")));
});

const HAS_NVIM = spawnSync("nvim", ["--version"], { timeout: 5000 }).status === 0;

test("view/lua: decor places inline/overlay virt_text, virt_lines and conceal extmarks", { skip: !HAS_NVIM }, () => {
    const dir = mkdtempSync(join(tmpdir(), "htmlview-decor-"));
    const script = join(dir, "decor.lua");
    const out = join(dir, "out.json");
    const decor = {
        virt: [
            [0, 3, "inline", [[" 🔗 u", ["Comment"]]], 200, -1, "link-target"],
            [1, 0, "overlay", [["• ", ["Title"]]], 200, -1, "marker"],
            [1, 0, "overlay", [["w", ["Title"]]], 200, 30, "marker"],
        ],
        virtLines: [[0, 0, [[["---", ["Comment"]]]]]],
        conceals: [[1, 2, 4, ""]],
    };
    writeFileSync(
        script,
        [
            `local M = assert(loadstring(${JSON.stringify(VIEW_LUA)}))()`,
            "local buf = vim.api.nvim_create_buf(false, true)",
            "local ns = vim.api.nvim_create_namespace('t')",
            `M.update(buf, ns, ns + 1, {'abc def', '  item'}, {}, {}, vim.json.decode(${JSON.stringify(JSON.stringify(decor))}))`,
            "local marks = vim.api.nvim_buf_get_extmarks(buf, ns, 0, -1, { details = true })",
            "local res = {}",
            "for _, m in ipairs(marks) do res[#res + 1] = { row = m[2], col = m[3], pos = m[4].virt_text_pos, win_col = m[4].virt_text_win_col, conceal = m[4].conceal, lines = m[4].virt_lines ~= nil } end",
            `local f = assert(io.open(${JSON.stringify(out)}, 'w')) f:write(vim.json.encode(res)) f:close()`,
            "vim.cmd('qa!')",
        ].join("\n")
    );
    const run = spawnSync("nvim", ["--headless", "--clean", "-l", script], { timeout: 10000 });
    const res: Array<Record<string, unknown>> = run.status === 0 && existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : [];
    rmSync(dir, { recursive: true, force: true });
    assert.ok(res.some((m) => m.pos === "inline" && m.row === 0), "inline virt_text");
    assert.ok(res.some((m) => m.pos === "overlay" && m.row === 1 && m.win_col === undefined), "overlay virt_text");
    assert.ok(res.some((m) => m.win_col === 30), "window-column overlay");
    assert.ok(res.some((m) => m.conceal === "" && m.row === 1), "conceal");
    assert.ok(res.some((m) => m.lines === true), "virt_lines");
});
