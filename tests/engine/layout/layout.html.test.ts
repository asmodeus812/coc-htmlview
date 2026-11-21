/**
 * Layout end to end from HTML and CSS (parse → style → layout), for behaviour that depends on the real UA sheet.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { Layout, VirtText } from "../../../src/types";
import { layoutBoxes, type LayoutOptions } from "../../../src/engine/layout";
import { defaultHostVars } from "../../../src/engine/style/host";
import { computeStyles, parseSheets } from "../../../src/engine/style/index";
import { parseDocument } from "../../../src/engine/dom";
import { emptyFormState } from "../../../src/engine/interact";

function lay(html: string, css: string = "", width: number = 20, opts: Partial<LayoutOptions> = {}): Layout {
    const sources = css ? [{ name: "t.css", text: css, origin: "author" as const }] : [];
    const tree = computeStyles(parseDocument(html), parseSheets(sources), { themeKind: "dark", vars: defaultHostVars }, emptyFormState());
    return layoutBoxes(tree, { width, tabstop: 4, ...opts });
}

const markers = (out: Layout): string[] => (out.virtText ?? []).filter((v: VirtText) => v.role === "marker").map((v: VirtText) => v.chunks.map((c) => c.text).join(""));

test("engine/layout: emoji are two cells, combining marks zero, both wrap by cells", () => {
    assert.deepEqual(lay("<p>😀😀😀😀😀😀 ab</p>", "", 6).lines, ["😀😀😀", "😀😀😀", "ab"]);
    assert.deepEqual(lay("<p>éééé xy</p>", "", 5).lines, ["éééé", "xy"]);
    assert.deepEqual(lay("<p>中文字符测试一二三四五六七八九十</p>", "", 10).lines, ["中文字符测", "试一二三四", "五六七八九", "十"]);
});

test("engine/layout: a zero-width space is a break opportunity", { skip: "known bug: long words break by cells and ignore U+200B" }, () => {
    assert.deepEqual(lay("<p>abc​defghij​klmnop</p>", "", 8).lines.map((l: string) => l.replace(/​/g, "")), ["abc", "defghij", "klmnop"]);
});

test("engine/layout: white-space pre-wrap, nowrap and pre-line", () => {
    assert.deepEqual(lay("<p style='white-space:pre-wrap'>a  b\nc   d e f g h</p>", "", 6).lines, ["a  b", "c   d", "e f g", "h"]);
    assert.deepEqual(lay("<p style='white-space:nowrap'>aaa bbb ccc ddd</p>", "", 6).lines, ["aaa bbb ccc ddd"]);
    assert.deepEqual(lay("<p style='white-space:pre-line'>a    b\n  c</p>", "", 20).lines, ["a b", "c"]);
});

test("engine/layout: tab-size sets the tab stops of pre, unset it is the tabstop option", () => {
    const at = (out: Layout): string[] => out.lines.map((l: string) => l.trimEnd());
    assert.deepEqual(at(lay("<pre style='padding:0'>\tx\n a\tb</pre>")), ["    x", " a  b"]);
    assert.deepEqual(at(lay("<pre style='padding:0'>\tx\n a\tb</pre>", "", 20, { tabstop: 8 })), ["        x", " a      b"]);
    assert.deepEqual(at(lay("<pre style='padding:0;tab-size:2'>\tx\n a\tb</pre>", "", 20, { tabstop: 8 })), ["  x", " a  b"]);
    assert.deepEqual(at(lay("<div style='tab-size:3'><pre style='padding:0'>\tx</pre></div>")), ["   x"], "tab-size is inherited");
});

test("engine/layout: link targets are hidden by default and shown inline with the option", () => {
    const html = "<p><a href='https://example.com/a'>go</a> <a href='#top'>up</a></p>";
    const hidden: Layout = lay(html, "", 60);
    assert.deepEqual(hidden.lines, ["go up"]);
    assert.equal((hidden.virtText ?? []).filter((v: VirtText) => v.role === "link-target").length, 0);
    assert.deepEqual(hidden.links.map((l) => [l.startCol, l.endCol]), [[0, 2], [3, 5]]);
    const shown: Layout = lay(html, "", 60, { linkTarget: { show: true, symbol: "🔗" } });
    const targets = (shown.virtText ?? []).filter((v: VirtText) => v.role === "link-target");
    assert.deepEqual(targets.map((v: VirtText) => [v.line, v.col, v.pos, v.chunks.map((c) => c.text).join("")]), [[0, 2, "inline", " 🔗 https://example.com/a"]]);
});

test("engine/layout: nested ordered lists count per level, start and value set the ordinal", () => {
    assert.deepEqual(markers(lay("<ol><li>a<ol><li>b</li><li>c</li></ol></li><li>d</li></ol>", "", 30)), ["1. ", "1. ", "2. ", "2. "]);
    assert.deepEqual(markers(lay("<ol start=5><li>a</li><li value=9>b</li><li>c</li></ol>", "", 30)), ["5. ", "9. ", "10. "]);
    assert.deepEqual(markers(lay("<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>", "", 30)), ["• ", "◦ ", "▪ "]);
    assert.deepEqual(markers(lay("<ul><li>a</li></ul>", "li::marker{content:'* '}", 30)), ["* "]);
});

test("engine/layout: a reversed ordered list counts down", { skip: "known bug: the ::marker counter ignores the reversed attribute" }, () => {
    assert.deepEqual(markers(lay("<ol reversed><li>x</li><li>y</li><li>z</li></ol>", "", 30)), ["3. ", "2. ", "1. "]);
});

test("engine/layout: counter-set restarts a counter in ::before content", () => {
    const css = "div{counter-reset:n} h2{counter-increment:n;margin:0} .s{counter-set:n 7} h2::before{content:counter(n) '. '}";
    assert.deepEqual(lay("<div><h2>a</h2><h2 class=s>b</h2><h2>c</h2></div>", css, 30).lines, ["1. a", "7. b", "8. c"]);
});

test("engine/layout: a colspan cell spans the columns of the next row", () => {
    const out: Layout = lay("<table><tr><td colspan=2>wide</td></tr><tr><td>a</td><td>b</td></tr></table>", "td{border:1px solid}", 30);
    assert.deepEqual(out.lines, ["┌───────┐", "│ wide  │", "│ a │ b │", "└───┴───┘"]);
});

test("engine/layout: flex items without order (0) come before positive orders", () => {
    assert.deepEqual(lay("<div style='display:flex'><span style='order:2'>B</span><span style='order:1'>A</span><span>Z</span></div>", "", 30).lines, ["Z A B"]);
});

test("engine/layout: right-aligned cells size to their content, not to the available width", () => {
    const html = "<table><tr><th>Scenario</th><th>v2.3</th></tr><tr><td>Cold build</td><td class=n>12.4 s</td></tr></table>";
    const out: Layout = lay(html, "td.n{text-align:right}", 60);
    assert.ok(out.lines.some((l: string) => l.includes("Cold build")), "the first column does not wrap");
    assert.ok(out.lines.every((l: string) => [...l].length <= 25), out.lines.join("\n"));
    assert.ok(out.lines.some((l: string) => /│\s+12\.4 s\s?│/.test(l) || / 12\.4 s/.test(l)), "still right-aligned in its column");
});

test("engine/layout: a wide spanning cell spreads its extra width over the spanned columns", () => {
    const html = "<table><tr><td>a</td><td>b</td><td>c</td></tr><tr><td colspan=3>a much longer spanning cell</td></tr></table>";
    const out: Layout = lay(html, "td{border:1px solid}", 60);
    const top: string = out.lines.find((l: string) => l.startsWith("┌")) ?? "";
    const widths: number[] = top.slice(1, -1).split("┬").map((s: string) => [...s].length);
    assert.equal(widths.length, 3, top);
    assert.ok(Math.max(...widths) - Math.min(...widths) <= 1, `even columns: ${top}`);
});

test("engine/layout: a block background tints its whole padding box, not only its text", () => {
    const css = "header{background:#2b5f8a;padding:1em 2ch;border-right:1px solid #fff} header p{margin:0}";
    const out: Layout = lay("<header><p>Title</p><p>a b</p></header><p>after</p>", css, 16);
    assert.deepEqual(out.lines, ["               │", "  Title        │", "  a b          │", "               │", "", "after"]);
    const tint = out.marks.filter((m) => m.group === "HtmlViewHeader").map((m) => [m.line, m.startCol, m.endCol]);
    assert.deepEqual(tint, [[0, 0, 15], [1, 0, 15], [2, 0, 15], [3, 0, 15]], "every line up to the right border, padding lines included");
    assert.equal(out.lines[5], "after", "lines outside the box keep their trailing spaces trimmed");
});
