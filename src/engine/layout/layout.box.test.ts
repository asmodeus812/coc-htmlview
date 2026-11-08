import { test } from "node:test";
import * as assert from "node:assert/strict";
import { buildBoxes, layoutBoxes } from "./index";
import type { Layout } from "../../types";
import type { ComputedStyle, StyledElement } from "../style";
import { B, I, box4, docRoot, edges, kit, layOut, solid, violations } from "./testkit";
import type { Kit } from "./testkit";

const P: Partial<ComputedStyle> = { display: "block", margin: edges(1, 0) };

test("engine/layout: inline wrapping by cells, CJK two cells wide", () => {
    const k: Kit = kit();
    const out: Layout = layOut(docRoot(k, [k.el("p", B, ["aaa bbb ccc"]), k.el("p", B, ["日本語テキスト"])]), k, { width: 7 });
    assert.deepEqual(out.lines, ["aaa bbb", "ccc", "日本語", "テキス", "ト"]);
});

test("engine/layout: whitespace collapses across elements, pre keeps it", () => {
    const k: Kit = kit();
    const out: Layout = layOut(docRoot(k, [k.el("p", B, ["  a  ", k.el("b", I, [" b "]), "  c "]), k.el("pre", { display: "block", whiteSpace: "pre" }, ["x  y\n\tz"])]), k);
    assert.deepEqual(out.lines, ["a b c", "x  y", "    z"]);
});

test("engine/layout: margins become blank lines, collapsed, none at the document edges", () => {
    const k: Kit = kit();
    const nested = k.el("div", { display: "block", margin: edges(2, 0) }, [k.el("p", P, ["b"])]);
    const out: Layout = layOut(docRoot(k, [k.el("p", P, ["a"]), nested, k.el("p", P, ["c"]), k.el("p", P, [])]), k);
    assert.deepEqual(out.lines, ["a", "", "", "b", "", "", "c"]);
});

test("engine/layout: borders and padding draw a box, nested boxes indent", () => {
    const k: Kit = kit();
    const inner = k.el("div", { display: "block", border: box4(solid()) }, ["in"]);
    const outer = k.el("div", { display: "block", border: box4(solid("double")), padding: edges(1, 1) }, ["out", inner]);
    const out: Layout = layOut(docRoot(k, [outer]), k, { width: 10 });
    assert.deepEqual(out.lines, ["╔════════╗", "║        ║", "║ out    ║", "║ ┌────┐ ║", "║ │in  │ ║", "║ └────┘ ║", "║        ║", "╚════════╝"]);
    assert.ok(out.marks.some((m) => m.group === "HtmlViewVscodeBorder" && m.line === 0));
});

test("engine/layout: left border only (blockquote) and a top-border rule (hr)", () => {
    const k: Kit = kit();
    const q = k.el("blockquote", { display: "block", padding: edges(0, 0, 0, 1), border: { ...box4({ style: "none", width: 0, color: { hex: "#000000", alpha: 1 } }), left: solid() } }, ["quoted text here"]);
    const hr = k.el("hr", { display: "block", border: { ...box4({ style: "none", width: 0, color: { hex: "#000000", alpha: 1 } }), top: solid() } });
    const out: Layout = layOut(docRoot(k, [q, hr]), k, { width: 10 });
    assert.deepEqual(out.lines, ["│ quoted", "│ text", "│ here", "──────────"]);
});

test("engine/layout: inline paint groups become marks, inner elements higher priority", () => {
    const k: Kit = kit();
    const out: Layout = layOut(docRoot(k, [k.el("p", B, ["a ", k.el("b", I, ["x ", k.el("i", I, ["y"], { paint: ["G2"] })], { paint: ["G1"] })])]), k);
    const g1 = out.marks.find((m) => m.group === "G1");
    const g2 = out.marks.find((m) => m.group === "G2");
    assert.deepEqual([g1?.startCol, g1?.endCol, g2?.startCol, g2?.endCol], [2, 5, 4, 5]);
    assert.ok((g2?.priority ?? 0) > (g1?.priority ?? 0));
});

test("engine/layout: display none dropped, ::before/::after content inline", () => {
    const k: Kit = kit();
    const out: Layout = layOut(docRoot(k, [k.el("p", B, ["a", k.el("span", { display: "none" }, ["gone"]), k.el("q", I, ["q"], { before: "“", after: "”" })])]), k);
    assert.deepEqual(out.lines, ["a“q”"]);
    assert.ok(out.marks.some((m) => m.group === "Pbefore" && m.startCol === 1));
});

test("engine/layout: forced breaks and a background code block with its region", () => {
    const k: Kit = kit();
    const pre = k.el("pre", { display: "block", whiteSpace: "pre", padding: edges(0, 1), backgroundColor: { var: "--vscode-textCodeBlock-background", attr: "bg" }, custom: { "--htmlview-code": "block" } }, [
        k.el("code", { display: "inline", whiteSpace: "pre" }, ["int a;\nlong bb;"], { attrs: { class: "language-java" } }),
    ], { paint: ["CodeBg"] });
    const out: Layout = layOut(docRoot(k, [k.el("p", B, ["x", k.el("br", { custom: { "--htmlview-break": "line" } }), "y"]), pre]), k, { width: 20 });
    assert.deepEqual(out.lines, ["x", "y", " int a;".padEnd(20), " long bb;".padEnd(20)]);
    assert.deepEqual(out.codeRegions, [{ startLine: 2, endLine: 3, startCol: 1, lang: "java", text: "int a;\nlong bb;" }]);
    assert.ok(out.marks.some((m) => m.group === "CodeBg" && m.line === 2 && m.startCol === 0 && m.endCol === 20));
    assert.deepEqual(out.folds, [{ startLine: 2, endLine: 3 }]);
});

test("engine/layout: code region language falls back to defaultLang", () => {
    const k: Kit = kit();
    const out: Layout = layOut(docRoot(k, [k.el("pre", { display: "block", whiteSpace: "pre", custom: { "--htmlview-code": "block" } }, ["a"])]), k, { defaultLang: "py" });
    assert.equal(out.codeRegions[0].lang, "py");
});

test("engine/layout: determinism, same tree same layout and boxes", () => {
    const k: Kit = kit();
    const root = docRoot(k, [k.el("p", P, ["a ", k.el("a", I, ["l"], { attrs: { href: "https://x" } })]), k.el("p", P, ["b"])]);
    assert.deepEqual(layoutBoxes(k.tree(root), { width: 20, tabstop: 4 }), layoutBoxes(k.tree(root), { width: 20, tabstop: 4 }));
    assert.deepEqual(buildBoxes(k.tree(root)), buildBoxes(k.tree(root)));
});
