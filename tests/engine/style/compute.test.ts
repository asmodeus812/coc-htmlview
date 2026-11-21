import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { Color, StyledElement, StyledNode, StyledTree, StyleEnv } from "../../../src/engine/style/index";
import type { GroupDef, Mark, ThemeKind } from "../../../src/types";
import { layoutBoxes } from "../../../src/engine/layout";
import { defaultHostVars } from "../../../src/engine/style/host";
import { computeStyles, parseSheets } from "../../../src/engine/style/index";
import { parseDocument } from "../../../src/engine/dom";
import { emptyFormState } from "../../../src/engine/interact";
import type { FormState } from "../../../src/engine/interact";

function render(html: string, css: string = "", kind: ThemeKind = "dark", state: FormState = emptyFormState()): StyledTree {
    const sources = css ? [{ name: "test.css", text: css, origin: "author" as const }] : [];
    const env: StyleEnv = { themeKind: kind, vars: defaultHostVars };
    return computeStyles(parseDocument(html), parseSheets(sources), env, state);
}

function all(tree: StyledTree): StyledElement[] {
    const out: StyledElement[] = [];
    const walk = (el: StyledElement): void => {
        out.push(el);
        el.children.filter((c: StyledNode): c is StyledElement => c.kind === "element").forEach(walk);
    };
    walk(tree.root);
    return out;
}

/** The element with `id` (or the first with tag `id`). */
function el(tree: StyledTree, id: string): StyledElement {
    const els: StyledElement[] = all(tree);
    const found: StyledElement | undefined = els.find((e: StyledElement) => e.element.attrs.id === id) || els.find((e: StyledElement) => e.element.tag === id);
    assert.ok(found, "no element " + id);
    return found;
}

const hex = (h: string, alpha: number = 1): Color => ({ hex: h, alpha });

test("engine/style: parseSheets puts the UA sheet first and chains rule order", () => {
    const sheets = parseSheets([{ name: "a.css", text: "p{color:red} q{color:blue}", origin: "author" }, { name: "b.css", text: "b{x:y}", origin: "user" }]);
    assert.deepEqual(sheets.map((s) => [s.name, s.origin]), [["ua.css", "ua"], ["a.css", "author"], ["b.css", "user"]]);
    const orders: number[] = sheets.flatMap((s) => s.rules.map((r) => r.order));
    assert.deepEqual(orders, orders.slice().sort((a, b) => a - b));
    assert.equal(new Set(orders).size, orders.length);
});

test("engine/style: inheritance, initial values and CSS-wide keywords", () => {
    const t = render('<div id="d"><p id="p"><span id="s">x</span></p><i id="i">y</i></div>', "#d{color:#ff0000;margin:2em 0;white-space:nowrap} #s{margin:inherit} #i{color:initial;white-space:unset}");
    assert.deepEqual(el(t, "s").style.color, hex("#ff0000"));
    assert.equal(el(t, "p").style.whiteSpace, "nowrap");
    assert.equal(el(t, "i").style.whiteSpace, "nowrap");
    assert.equal(el(t, "s").style.margin.top, 1, "inherit takes the parent p's 1em margin");
    assert.deepEqual(el(t, "i").style.color, { group: "HtmlViewHostCanvas", attr: "fg" });
    assert.equal(el(t, "d").style.margin.top, 2);
    assert.equal(el(t, "i").style.display, "inline");
});

test("engine/style: var() with fallbacks, :root custom properties and host variables", () => {
    const css = ":root{--a:#00ff00;--chain:var(--vscode-textLink-foreground);--loop:var(--loop2);--loop2:var(--loop)}" +
        "#f{color:var(--nope, var(--a))} #h{color:var(--vscode-textLink-foreground, red)} #c{color:var(--chain)}" +
        "#bad{color:var(--nope)} #cyc{color:var(--loop, blue)} #m{background:var(--htmlview-mark-foreground) url(x.png)}";
    const t = render('<p id="bad"><b id="f">a</b><b id="h">b</b><b id="c">c</b><b id="cyc">d</b><b id="m">e</b></p>', css);
    assert.deepEqual(el(t, "f").style.color, hex("#00ff00"));
    assert.deepEqual(el(t, "h").style.color, { var: "--vscode-textLink-foreground", attr: "fg" });
    assert.deepEqual(el(t, "c").style.color, { var: "--vscode-textLink-foreground", attr: "fg" });
    assert.deepEqual(el(t, "bad").style.color, { var: "--vscode-editor-foreground", attr: "fg" }, "invalid at computed time: unset = inherit");
    assert.deepEqual(el(t, "cyc").style.color, hex("#0000ff"));
    assert.deepEqual(el(t, "m").style.backgroundColor, { var: "--htmlview-mark-foreground", attr: "fg" });
    assert.equal(el(t, "f").style.custom["--a"], "#00ff00");
    assert.equal(el(t, "f").style.custom["--loop"], undefined);
});

test("engine/style: literal colours, alpha, currentcolor", () => {
    const css = "#a{color:rgba(10,20,30,0.5)} #b{color:hsl(120,100%,25%)} #c{color:rebeccapurple;border:1px solid} #d{color:#abc8;background:transparent;border-right:2px dashed currentColor}";
    const t = render('<p><i id="a">a</i><i id="b">b</i><i id="c">c</i><i id="d">d</i></p>', css);
    assert.deepEqual(el(t, "a").style.color, hex("#0a141e", 0.5));
    assert.deepEqual(el(t, "b").style.color, hex("#008000"));
    assert.deepEqual(el(t, "c").style.border.left, { style: "solid", width: 1, color: hex("#663399") });
    assert.equal(el(t, "d").style.color.hasOwnProperty("hex") && (el(t, "d").style.color as { alpha: number }).alpha, 0.533);
    assert.deepEqual(el(t, "d").style.border.right.color, el(t, "d").style.color);
    assert.equal(el(t, "d").style.border.right.style, "dashed");
    assert.equal(el(t, "d").style.border.top.width, 0);
    assert.equal((el(t, "d").style.backgroundColor as { alpha: number }).alpha, 0);
});

test("engine/style: lengths to cells, box shorthands and borders", () => {
    const css = "#x{margin:16px 2ch 2em -1.5rem;padding:10px;border:none;border-top:3px double #fff} #y{padding:0.2em 0.5em;border-width:thin;border-style:solid none}";
    const t = render('<div id="x">a</div><div id="y">b</div>', css);
    assert.deepEqual(el(t, "x").style.margin, { top: 1, right: 2, bottom: 2, left: -2 });
    assert.deepEqual(el(t, "x").style.padding, { top: 1, right: 1, bottom: 1, left: 1 });
    assert.deepEqual(el(t, "x").style.border.top, { style: "double", width: 1, color: hex("#ffffff") });
    assert.equal(el(t, "x").style.border.left.width, 0);
    assert.deepEqual(el(t, "y").style.padding, { top: 0, right: 1, bottom: 0, left: 1 });
    assert.deepEqual([el(t, "y").style.border.top.width, el(t, "y").style.border.right.width], [1, 0]);
});

test("engine/style: display, blockification and flex direction", () => {
    const css = ".f{display:flex} .c{display:inline-flex;flex-direction:column} .g{display:grid} #t{display:table-cell}";
    const t = render('<div class="f"><span id="s">a</span><label id="l" class="c">b</label></div><dl class="g"><dd id="dd">x</dd></dl><div class="f"><i id="t">c</i></div>', css);
    assert.equal(el(t, "s").style.display, "block");
    assert.equal(el(t, "l").style.display, "block", "column flex computes to block");
    assert.equal(el(t, "dl").style.display, "block");
    assert.equal(el(t, "t").style.display, "block");
    assert.equal(el(t, "head").style.display, "none");
});

test("engine/style: list items, markers and counters", () => {
    const html = '<ol id="o" start="3"><li id="a">a</li><li id="b">b<ul><li id="n">n<ul><li id="nn">m</li></ul></li></ul></li><li id="v" value="10">v</li><li id="w">w</li></ol>' +
        '<ol type="a"><li id="al">x</li><li id="al2">y</li></ol><ul style="list-style:none"><li id="none">z</li></ul><ul class="s"><li id="str">s</li></ul>';
    const t = render(html, '.s{list-style-type:"\\2192  "}');
    assert.equal(el(t, "a").style.display, "list-item");
    assert.equal(el(t, "a").marker?.text, "3. ");
    assert.equal(el(t, "b").marker?.text, "4. ");
    assert.equal(el(t, "n").marker?.text, "\u25E6 ");
    assert.equal(el(t, "n").style.listStyleType, "circle");
    assert.equal(el(t, "nn").style.listStyleType, "square");
    assert.equal(el(t, "v").marker?.text, "10. ");
    assert.equal(el(t, "w").marker?.text, "11. ");
    assert.equal(el(t, "al2").marker?.text, "b. ");
    assert.equal(el(t, "none").marker, undefined);
    assert.deepEqual(el(t, "str").style.listStyleType, { string: "\u2192 " });
    assert.deepEqual(el(t, "a").marker?.paint, ["HtmlViewLiMarker"]);
    assert.deepEqual(el(t, "o").style.counterReset, [{ name: "list-item", value: 2 }]);
});

test("engine/style: ::before/::after content with counters, attr() and quotes", () => {
    const css = "body{counter-reset:sec} h2{counter-increment:sec} h2::before{content:counter(sec) \". \" attr(data-x)} h2::after{content:none}" +
        " .n::after{content:counters(sec, \".\", upper-roman)}";
    const t = render('<h2 data-x="A">x</h2><h2 id="h" data-x="B">y</h2><p class="n" id="n"><q id="q">z<q id="q2">w</q></q></p>', css);
    assert.equal(el(t, "h").before?.text, "2. B");
    assert.equal(el(t, "h").after, undefined);
    assert.equal(el(t, "n").after?.text, "II");
    assert.equal(el(t, "q").before?.text, "\u201C");
    assert.equal(el(t, "q2").before?.text, "\u2018");
    assert.equal(el(t, "q2").after?.text, "\u2019");
    assert.equal(el(t, "q").after?.text, "\u201D");
});

test("engine/style: layout hints come from ua.css and are not inherited", () => {
    const t = render('<h2 id="h"><span id="s">x</span></h2><pre id="p"><code id="c">y</code></pre><a id="a" href="u">l</a><img id="i" alt="z"><label id="l" for="r">r</label><br id="br">');
    assert.equal(el(t, "h").style.custom["--htmlview-heading"], "2");
    assert.equal(el(t, "s").style.custom["--htmlview-heading"], undefined);
    assert.equal(el(t, "p").style.custom["--htmlview-code"], "block");
    assert.equal(el(t, "c").style.custom["--htmlview-code"], undefined);
    assert.equal(el(t, "p").style.whiteSpace, "pre");
    assert.equal(el(t, "c").style.whiteSpace, "pre");
    assert.equal(el(t, "a").style.custom["--htmlview-link"], "href");
    assert.equal(el(t, "i").style.custom["--htmlview-replaced"], "alt");
    assert.equal(el(t, "l").style.custom["--htmlview-toggle"], "label");
    assert.equal(el(t, "br").style.custom["--htmlview-break"], "line");
    const off = render('<pre id="p">y</pre>', "pre{--htmlview-code:none}");
    assert.equal(el(off, "p").style.custom["--htmlview-code"], "none");
});

test("engine/style: weights, styles and decorations", () => {
    const t = render('<h1 id="h"><b id="b">x</b></h1><p><strong id="s">s</strong><em id="e">e</em><del id="d">d</del><u id="u">u</u></p><p id="t">t</p>', "#t{text-decoration:underline line-through wavy red;font:italic bold 12px serif}");
    assert.equal(el(t, "h").style.fontWeight, 700);
    assert.equal(el(t, "b").style.fontWeight, 900, "bolder over 700");
    assert.equal(el(t, "s").style.fontWeight, 700);
    assert.equal(el(t, "e").style.fontStyle, "italic");
    assert.equal(el(t, "d").style.textDecoration.lineThrough, true);
    assert.equal(el(t, "u").style.textDecoration.underline, true);
    assert.deepEqual(el(t, "t").style.textDecoration, { underline: true, lineThrough: true, overline: false, color: hex("#ff0000") });
    assert.deepEqual([el(t, "t").style.fontWeight, el(t, "t").style.fontStyle], [700, "italic"]);
});

test("engine/style: :checked from the form state drives display; document <style> is author", () => {
    const html = '<style>.tab{display:none} #r1:checked ~ #t1{display:block}</style><input type="radio" name="g" id="r0"><input type="radio" name="g" id="r1"><div class="tab" id="t1">x</div>';
    const off = render(html);
    assert.equal(el(off, "t1").style.display, "none");
    const on = render(html, "", "dark", { radios: new Map([["g", "r1"]]), checkboxes: new Map() });
    assert.equal(el(on, "t1").style.display, "block");
    assert.equal(el(on, "r1").style.custom["--htmlview-toggle"], "control");
});

test("engine/style: hljs token rules define groups although no element matches them", () => {
    const tree = render("<p>x</p>", ".hljs-number{color:#123456} .hljs-a, .hljs-b{font-weight:700} div .hljs-c{color:red}");
    const group = (name: string) => tree.groups.find((g) => g.name === name);
    assert.deepEqual(group("HtmlViewHljsNumber")?.fg, { hex: "#123456" });
    assert.equal(group("HtmlViewHljsA")?.bold, true);
    assert.equal(group("HtmlViewHljsB")?.bold, true);
    assert.equal(group("HtmlViewDivHljsC"), undefined);
});

test("engine/style: align-items normalises its keywords, is not inherited and starts at normal", () => {
    const t = render(
        '<div id="a"><p id="p">x</p></div><div id="b"></div><div id="c"></div><div id="d"></div><div id="e"></div>',
        "#a{align-items:center} #b{align-items:flex-end} #c{align-items:FLEX-START} #d{align-items:stretch} #e{align-items:bogus}",
    );
    assert.equal(el(t, "a").style.alignItems, "center");
    assert.equal(el(t, "p").style.alignItems, "normal", "not inherited");
    assert.equal(el(t, "b").style.alignItems, "end");
    assert.equal(el(t, "c").style.alignItems, "start");
    assert.equal(el(t, "d").style.alignItems, "stretch");
    assert.equal(el(t, "e").style.alignItems, "normal", "invalid value is dropped");
});

test("engine/style: literal border colours get their own fg-only group, variables keep theirs", () => {
    const html: string = '<div id="a">a</div><div id="b">b</div><div id="c">c</div><div id="d">d</div><div id="e">e</div>';
    const css: string =
        "#a{border:1px solid #8FCAEA} #b{color:#8FCAEA;border:1px solid} #c{border:1px solid rgba(250,220,121,.2)}" +
        " #d{border:1px solid var(--vscode-textLink-foreground)} #e{border:1px solid transparent}";
    const tree: StyledTree = render(html, css);
    const groups: string[] = layoutBoxes(tree, { width: 20, tabstop: 4 }).marks.map((m: Mark): string => m.group);
    const def = (name: string): GroupDef | undefined => tree.groups.find((g: GroupDef): boolean => g.name === name);
    assert.deepEqual(def("HtmlViewBorder8fcaea"), { name: "HtmlViewBorder8fcaea", fg: { hex: "#8fcaea" } });
    assert.deepEqual(def("HtmlViewBorderfadc79A200"), { name: "HtmlViewBorderfadc79A200", fg: { hex: "#fadc79", alpha: 0.2 } });
    assert.equal(groups.filter((g: string): boolean => g === "HtmlViewBorder8fcaea").length, 8);
    assert.equal(groups.filter((g: string): boolean => g === "HtmlViewBorderfadc79A200").length, 4);
    assert.equal(groups.filter((g: string): boolean => g === "HtmlViewVscodeTextLinkForeground").length, 4);
    assert.equal(groups.filter((g: string): boolean => g === "HtmlViewHostBorder").length, 4);
    assert.equal(tree.groups.filter((g: GroupDef): boolean => g.name.startsWith("HtmlViewBorder")).length, 2);
});

test("engine/style: sheet order UA → htmlview.stylesheets → caller sheets → document <style> → inline", () => {
    const sources = [
        { name: "user.css", text: "p{color:#000001;margin:0} #imp{color:#0000aa !important} .spec#spec{color:#0000bb}", origin: "author" as const },
        { name: "caller.css", text: "p{color:#000002} #c,#s,#i{color:#000002} #spec{color:#0000cc}", origin: "author" as const },
    ];
    const html = "<style>#s,#i{color:#000003} #imp{color:#000003}</style><p id='u2'>a</p><p id='c'>b</p><p id='s'>c</p><p id='i' style='color:#000004'>d</p>" +
        "<p id='imp' style='color:#000004'>e</p><p id='spec' class='spec'>f</p><blockquote id='ua'>g</blockquote>";
    const t = computeStyles(parseDocument(html), parseSheets(sources), { themeKind: "dark", vars: defaultHostVars }, emptyFormState());
    assert.deepEqual(el(t, "u2").style.color, hex("#000002"), "the caller's sheet follows htmlview.stylesheets");
    assert.deepEqual(el(t, "s").style.color, hex("#000003"), "document <style> follows every given sheet");
    assert.deepEqual(el(t, "i").style.color, hex("#000004"), "inline style is last");
    assert.deepEqual(el(t, "imp").style.color, hex("#0000aa"), "an earlier !important beats later and inline normal");
    assert.deepEqual(el(t, "spec").style.color, hex("#0000bb"), "specificity beats order across sheets");
    assert.ok(el(t, "ua").style.margin.left > 0, "UA rules apply where no author rule does");
    assert.equal(el(t, "u2").style.margin.top, 0, "an author rule beats the UA margin");
});

test("engine/style: unset resets a non-inherited property, initial resets an inherited one", () => {
    const t = render('<div id="d"><p id="p">x</p><b id="b">y</b></div>', "#d{font-style:italic} #p{margin:unset;padding:1ch} #b{font-style:initial;padding:unset}");
    assert.equal(el(t, "p").style.margin.top, 0);
    assert.equal(el(t, "p").style.padding.left, 1);
    assert.equal(el(t, "p").style.fontStyle, "italic");
    assert.equal(el(t, "b").style.fontStyle, "normal");
    assert.equal(el(t, "b").style.padding.left, 0);
});

test("engine/style: the body class follows the theme kind for vscode-light/dark selectors", () => {
    const css = "body.vscode-light #x{color:#111111} body.vscode-dark #x{color:#eeeeee}";
    assert.deepEqual(el(render('<p id="x">a</p>', css, "light"), "x").style.color, hex("#111111"));
    assert.deepEqual(el(render('<p id="x">a</p>', css, "dark"), "x").style.color, hex("#eeeeee"));
});

test("engine/style: nested list counters with counters() and counter-set", () => {
    const css = "ol{counter-reset:item} li{display:block;counter-increment:item} li::before{content:counters(item, \".\") \" \"} .jump{counter-set:item 9}";
    const t = render('<ol><li id="a">a<ol><li id="b">b</li><li id="c" class="jump">c</li><li id="d">d</li></ol></li><li id="e">e</li></ol>', css);
    assert.deepEqual(["a", "b", "c", "d", "e"].map((id: string) => el(t, id).before?.text), ["1 ", "1.1 ", "1.9 ", "1.10 ", "2 "]);
});
