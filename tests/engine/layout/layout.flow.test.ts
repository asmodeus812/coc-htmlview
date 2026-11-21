import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { Layout } from "../../../src/types";
import type { ComputedStyle, StyledElement } from "../../../src/engine/style";
import { B, I, box4, docRoot, edges, kit, layOut, solid, violations } from "./testkit";
import type { Kit } from "./testkit";

const UL: Partial<ComputedStyle> = { display: "block", padding: edges(0, 0, 0, 3) };
const LI: Partial<ComputedStyle> = { display: "list-item" };
const OL: Partial<ComputedStyle> = { ...UL, listStyleType: "decimal" };
const LINK = (href: string): [Partial<ComputedStyle>, { attrs: Record<string, string>; paint: string[] }] => [
    { display: "inline", custom: { "--htmlview-link": "href" } },
    { attrs: { href }, paint: ["Link"] },
];

test("engine/layout: list markers as buffer text with virtual false, hanging indent", () => {
    const k: Kit = kit();
    const nested = k.el("ul", UL, [k.el("li", LI, ["inner"], { marker: "◦ " })]);
    const ul = k.el("ul", UL, [k.el("li", LI, ["one two three"], { marker: "• ", paint: [] }), k.el("li", LI, ["b", nested], { marker: "• " })]);
    const out: Layout = layOut(docRoot(k, [ul]), k, { width: 12, virtual: false });
    assert.deepEqual(out.lines, [" • one two", "   three", " • b", "    ◦ inner"]);
    assert.ok(out.marks.some((m) => m.group === "Pmarker" && m.line === 0 && m.startCol === 1 && m.endCol === 3));
    assert.deepEqual(out.virtText, []);
});

test("engine/layout: list markers as overlay virtual text by default", () => {
    const k: Kit = kit();
    const out: Layout = layOut(docRoot(k, [k.el("ul", UL, [k.el("li", LI, ["a"], { marker: "• " })])]), k);
    assert.deepEqual(out.lines, ["   a"]);
    assert.deepEqual(out.virtText, [{ line: 0, col: 1, pos: "overlay", chunks: [{ text: "• ", groups: ["Pmarker"] }], role: "marker" }]);
});

test("engine/layout: computed ordinals, wide markers hang the whole list, inside markers inline", () => {
    const k: Kit = kit();
    const items: StyledElement[] = Array.from({ length: 10 }, (_v: unknown, i: number): StyledElement => k.el("li", { ...LI, listStyleType: "decimal" }, [`i${i + 1}`]));
    const out: Layout = layOut(docRoot(k, [k.el("ol", OL, items)]), k, { virtual: false });
    assert.equal(out.lines[0], " 1. i1");
    assert.equal(out.lines[9], "10. i10");
    const k2: Kit = kit();
    const inside = k2.el("ul", { ...UL, listStylePosition: "inside" }, [k2.el("li", { ...LI, listStylePosition: "inside" }, ["x"], { marker: "• " })]);
    const v: Layout = layOut(docRoot(k2, [inside]), k2);
    assert.deepEqual(v.lines, ["   x"]);
    assert.equal((v.virtText ?? [])[0].pos, "inline");
    assert.equal((v.virtText ?? [])[0].col, 3);
    assert.deepEqual(layOut(docRoot(k2, [inside]), k2, { virtual: false }).lines, ["   • x"]);
});

test("engine/layout: list item without inline content keeps its marker on its own line", () => {
    const k: Kit = kit();
    const out: Layout = layOut(docRoot(k, [k.el("ul", UL, [k.el("li", LI, [], { marker: "• " })])]), k);
    assert.deepEqual(out.lines, [" •"]);
});

test("engine/layout: table grid from computed borders, header rule, wrapping cells", () => {
    const k: Kit = kit();
    const cell: Partial<ComputedStyle> = { display: "table-cell", padding: edges(0, 1), border: box4(solid()) };
    const table = k.el("table", { display: "table", border: box4(solid()) }, [
        k.el("thead", { display: "table-header-group" }, [k.el("tr", { display: "table-row" }, [k.el("th", cell, ["Name"], { paint: ["Th"] }), k.el("th", cell, ["V"])])]),
        k.el("tbody", { display: "table-row-group" }, [k.el("tr", { display: "table-row" }, [k.el("td", cell, ["a"]), k.el("td", cell, ["1"])])]),
    ]);
    const out: Layout = layOut(docRoot(k, [table]), k);
    assert.deepEqual(out.lines, ["┌──────┬───┐", "│ Name │ V │", "├──────┼───┤", "│ a    │ 1 │", "└──────┴───┘"]);
    assert.ok(out.marks.some((m) => m.group === "Th" && m.line === 1 && m.startCol === 2));
    const narrow: Layout = layOut(docRoot(k, [table]), k, { width: 9 });
    assert.deepEqual(narrow.lines, [" Name", "   a", " V", "   1"]);
});

test("engine/layout: borderless table separates columns by a space, too narrow tables stack", () => {
    const k: Kit = kit();
    const td: Partial<ComputedStyle> = { display: "table-cell" };
    const table = k.el("table", { display: "table" }, [k.el("tr", { display: "table-row" }, [k.el("td", td, ["ab"]), k.el("td", td, ["cd"])])]);
    assert.deepEqual(layOut(docRoot(k, [table]), k).lines, ["ab cd"]);
    const k2: Kit = kit();
    const t2 = k2.el("table", { display: "table" }, [
        k2.el("thead", { display: "table-header-group" }, [k2.el("tr", { display: "table-row" }, [k2.el("th", td, ["Head"]), k2.el("th", td, ["Other"])])]),
        k2.el("tr", { display: "table-row" }, [k2.el("td", td, ["longword"]), k2.el("td", td, ["value"])]),
    ]);
    assert.deepEqual(layOut(docRoot(k2, [t2]), k2, { width: 10 }).lines, ["Head", "  longword", "Other", "  value"]);
});

test("engine/layout: flex row lays items side by side, wraps greedily when too wide", () => {
    const k: Kit = kit();
    const flex = k.el("div", { display: "flex" }, [k.el("span", B, ["A"]), k.el("span", B, ["Bb"]), "c"]);
    assert.deepEqual(layOut(docRoot(k, [flex]), k).lines, ["A Bb c"]);
    assert.deepEqual(layOut(docRoot(k, [flex]), k, { width: 4 }).lines, ["A Bb", "c"]);
    assert.deepEqual(layOut(docRoot(k, [flex]), k, { width: 3 }).lines, ["A", "Bb", "c"]);
});

test("engine/layout: flex items shrink to their max-content, capped at the container width", () => {
    const k: Kit = kit();
    const flex = k.el("div", { display: "flex" }, [k.el("span", B, ["one two three"]), k.el("span", B, ["x"])]);
    assert.deepEqual(layOut(docRoot(k, [flex]), k, { width: 9 }).lines, ["one two", "three", "x"]);
});

test("engine/layout: flex items follow order, and a width:100% item takes its own row", () => {
    const k = kit();
    const flex = k.el("div", { display: "flex" }, [k.el("span", { ...B, order: 99, fill: true }, ["body"]), k.el("span", { ...B, order: 1 }, ["A"]), k.el("span", { ...B, order: 1 }, ["B"])]);
    assert.deepEqual(layOut(docRoot(k, [flex]), k, { width: 20 }).lines, ["A B", "body"]);
});

const CAPSULE: Partial<ComputedStyle> = { display: "flex", border: box4(solid()), padding: edges(0, 1) };

test("engine/layout: a single flex item and a bordered capsule do not stretch", () => {
    const k: Kit = kit();
    const single = k.el("div", { display: "flex" }, [k.el("span", { display: "block", border: box4(solid()) }, ["Hi"])]);
    assert.deepEqual(layOut(docRoot(k, [single]), k).lines, ["┌──┐", "│Hi│", "└──┘"]);
    const k2: Kit = kit();
    const capsule = k2.el("div", CAPSULE, ["Low"]);
    const row = k2.el("div", { display: "flex" }, [capsule]);
    assert.deepEqual(layOut(docRoot(k2, [row]), k2).lines, ["┌─────┐", "│ Low │", "└─────┘"]);
});

test("engine/layout: a row of capsules sits inline and wraps (the demo's taxonomy)", () => {
    const k: Kit = kit();
    const caps = ["Security", "High", "Info"].map((t: string): StyledElement => k.el("span", { ...CAPSULE, margin: edges(0, 0, 1, 0) }, [t]));
    const plain = k.el("span", { display: "flex", padding: edges(0, 1) }, [k.el("span", B, ["Consistency"]), k.el("span", B, ["Conventional"])]);
    const tax = k.el("div", { display: "flex" }, [plain, ...caps]);
    assert.deepEqual(layOut(docRoot(k, [tax]), k, { width: 40 }).lines, [
        " Consistency Conventional  ┌──────────┐",
        "                           │ Security │",
        "                           └──────────┘",
        "",
        "┌──────┐ ┌──────┐",
        "│ High │ │ Info │",
        "└──────┘ └──────┘",
    ]);
});

test("engine/layout: links per line, the shown target as inline virtual text counted when wrapping, hidden by default", () => {
    const k: Kit = kit();
    const [ls, lo] = LINK("https://x.io");
    const [as, ao] = LINK("#sec");
    const out: Layout = layOut(docRoot(k, [k.el("p", B, ["see ", k.el("a", ls, ["the docs"], lo), " or ", k.el("a", as, ["here"], ao)])]), k, { width: 20, linkTarget: { show: true, symbol: "🔗" } });
    assert.deepEqual(out.lines, ["see the", "docs", "or here"]);
    assert.deepEqual(out.links, [
        { line: 0, startCol: 4, endCol: 7, target: { kind: "url", href: "https://x.io" } },
        { line: 1, startCol: 0, endCol: 4, target: { kind: "url", href: "https://x.io" } },
        { line: 2, startCol: 3, endCol: 7, target: { kind: "anchor", id: "sec" } },
    ]);
    assert.deepEqual(out.virtText, [{ line: 1, col: 4, pos: "inline", chunks: [{ text: " 🔗 https://x.io", groups: ["HtmlViewHostLinkUrl"] }], role: "link-target" }]);
    const hidden: Layout = layOut(docRoot(k, [k.el("p", B, ["see ", k.el("a", ls, ["the docs"], lo)])]), k, { width: 20 });
    assert.deepEqual([hidden.lines, hidden.virtText], [["see the docs"], []]);
});

test("engine/layout: toggle labels become context links; replaced elements show alt text", () => {
    const k: Kit = kit();
    const radio = k.el("input", { display: "none", custom: { "--htmlview-toggle": "control" } }, [], { attrs: { type: "radio", id: "t1", name: "tabs" } });
    const label = k.el("label", { display: "inline", custom: { "--htmlview-toggle": "label" } }, ["Tab"], { attrs: { for: "t1" } });
    const img = k.el("img", { display: "inline-block", custom: { "--htmlview-replaced": "alt" } }, [], { attrs: { alt: "logo" } });
    const out: Layout = layOut(docRoot(k, [k.el("div", B, [radio, label, " ", img])]), k);
    assert.deepEqual(out.lines, ["Tab [logo]"]);
    assert.deepEqual(out.links, [{ line: 0, startCol: 0, endCol: 3, target: { kind: "context", contexts: "tabs", key: "t1" } }]);
});

test("engine/layout: anchors for headings and ids, unique slugs, heading folds", () => {
    const k: Kit = kit();
    const h = (lvl: number, text: string, attrs: Record<string, string> = {}): StyledElement =>
        k.el(`h${lvl}`, { display: "block", margin: edges(1, 0), custom: { "--htmlview-heading": String(lvl) } }, [text], { before: "◆ ", attrs });
    const p = (text: string, attrs: Record<string, string> = {}): StyledElement => k.el("p", { display: "block", margin: edges(1, 0) }, [text], { attrs });
    const out: Layout = layOut(docRoot(k, [h(1, "Intro Part"), p("a"), h(2, "Sub"), p("b", { id: "pb" }), h(2, "Sub"), p("c"), h(1, "End", { id: "end" }), p("d")]), k);
    assert.deepEqual(out.anchors, [
        { id: "intro-part", line: 0, level: 1, title: "Intro Part" },
        { id: "sub", line: 4, level: 2, title: "Sub" },
        { id: "pb", line: 6 },
        { id: "sub-1", line: 8, level: 2, title: "Sub" },
        { id: "end", line: 12, level: 1, title: "End" },
    ]);
    assert.deepEqual(out.folds, [
        { startLine: 0, endLine: 10 },
        { startLine: 4, endLine: 6 },
        { startLine: 8, endLine: 10 },
        { startLine: 12, endLine: 14 },
    ]);
});

test("engine/layout: background block marks cover the box, invariants hold on a mixed document", () => {
    const k: Kit = kit();
    const banner = k.el("div", { display: "block", padding: edges(0, 1), backgroundColor: { hex: "#ff0000", alpha: 1 } }, ["warn ", k.el("code", { display: "inline", padding: edges(0, 1) }, ["x"], { paint: ["Code"] })], { paint: ["Banner"] });
    const out: Layout = layOut(docRoot(k, [banner, k.el("p", { display: "block", textAlign: "center" }, ["mid"])]), k, { width: 11 });
    assert.deepEqual(out.lines, [" warn  x", "    mid"]);
    assert.ok(out.marks.some((m) => m.group === "Banner" && m.startCol === 0 && m.endCol === 8));
    assert.ok(out.marks.some((m) => m.group === "Code" && m.startCol === 6 && m.endCol === 8));
});

test("engine/layout: table cells wrap within fitted columns, tall body rows are ruled apart, CJK breaks between wide characters", () => {
    const k: Kit = kit();
    const cell: Partial<ComputedStyle> = { display: "table-cell", padding: edges(0, 1), border: box4(solid()) };
    const row = (a: string, b: string): StyledElement => k.el("tr", { display: "table-row" }, [k.el("td", cell, [a]), k.el("td", cell, [b])]);
    const out: Layout = layOut(docRoot(k, [k.el("table", { display: "table", border: box4(solid()) }, [row("日本", "one two three four"), row("x", "y")])]), k, { width: 16 });
    assert.deepEqual(out.lines, ["┌─────┬────────┐", "│ 日  │ one    │", "│ 本  │ two    │", "│     │ three  │", "│     │ four   │", "├─────┼────────┤", "│ x   │ y      │", "└─────┴────────┘"]);
});

test("engine/layout: align-items places a short flex item at the top (default), middle or bottom of its row", () => {
    const rowOf = (alignItems?: ComputedStyle["alignItems"]): string[] => {
        const k: Kit = kit();
        const tall = k.el("span", { display: "block", border: box4(solid()) }, ["Hi"]);
        const flex = k.el("div", { display: "flex", ...(alignItems !== undefined ? { alignItems } : {}) }, [k.el("span", B, ["x"]), tall]);
        return layOut(docRoot(k, [flex]), k).lines;
    };
    assert.deepEqual(rowOf(), ["x ┌──┐", "  │Hi│", "  └──┘"]);
    assert.deepEqual(rowOf("center"), ["  ┌──┐", "x │Hi│", "  └──┘"]);
    assert.deepEqual(rowOf("end"), ["  ┌──┐", "  │Hi│", "x └──┘"]);
    for (const a of ["normal", "stretch", "start"] as const) {
        assert.deepEqual(rowOf(a), rowOf(), a);
    }
});

test("engine/layout: align-items center rounds down in an odd gap", () => {
    const k: Kit = kit();
    const tall = k.el("div", { display: "block" }, [k.el("p", { display: "block" }, ["a"]), k.el("p", { display: "block" }, ["b"])]);
    const flex = k.el("div", { display: "flex", alignItems: "center" }, [k.el("span", B, ["x"]), tall]);
    assert.deepEqual(layOut(docRoot(k, [flex]), k).lines, ["x a", "  b"]);
});
