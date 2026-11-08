import { test } from "node:test";
import * as assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { elementChildren, parentElement, parseDocument } from "./index";
import type { DomDocument, DomElement, DomNode, DomText } from "./index";
import { byTag } from "../../testutil";

function sampleDoc(): DomDocument {
    const text: DomText = { type: "text", id: 3, text: "x" };
    const p: DomElement = { type: "element", id: 2, tag: "p", attrs: {}, classList: [], children: [text] };
    const body: DomElement = { type: "element", id: 1, tag: "body", attrs: {}, classList: [], children: [p] };
    const root: DomElement = { type: "element", id: 0, tag: "html", attrs: {}, classList: [], children: [body] };
    return { root, body, nodes: [root, body, p, text], parent: [-1, 0, 1, 2], styles: [] };
}

test("engine/dom: helpers walk preorder ids without parent pointers", () => {
    const doc: DomDocument = sampleDoc();
    assert.deepEqual(elementChildren(doc.body).map((e) => e.tag), ["p"]);
    assert.equal(parentElement(doc, 2)?.tag, "body");
    assert.equal(parentElement(doc, 0), undefined);
});

const FIXTURES: string = join(process.cwd(), "src", "__fixtures__");

function fixtureNames(): string[] {
    return readdirSync(FIXTURES).filter((n: string) => n.endsWith(".html"));
}

function textOf(n: DomNode): string {
    return n.type === "text" ? n.text : n.children.map(textOf).join("");
}

test("engine/dom: every fixture parses with preorder unique ids and consistent parents", () => {
    const names: string[] = fixtureNames();
    assert.ok(names.length > 5);
    for (const name of names) {
        const doc: DomDocument = parseDocument(readFileSync(join(FIXTURES, name), "utf8"));
        assert.equal(doc.root.id, 0, name);
        assert.equal(doc.root.tag, "html");
        assert.equal(doc.body.tag, "body");
        assert.equal(doc.parent[0], -1);
        assert.equal(doc.nodes.length, doc.parent.length);
        const order: number[] = [];
        const walk = (n: DomNode, p: number): void => {
            order.push(n.id);
            assert.equal(doc.nodes[n.id], n, name);
            assert.equal(doc.parent[n.id], p, name);
            if (n.type === "element") {
                n.children.forEach((c: DomNode) => walk(c, n.id));
            }
        };
        walk(doc.root, -1);
        assert.deepEqual(order, order.map((_: number, i: number) => i), name);
        assert.equal(order.length, doc.nodes.length);
        assert.ok(doc.nodes.includes(doc.body));
        for (const n of doc.nodes) {
            assert.ok(n.type !== "text" || n.text !== "");
        }
    }
});

test("engine/dom: fragment gets implied html, head and body", () => {
    const doc: DomDocument = parseDocument("<!DOCTYPE html><p>x</p>");
    assert.deepEqual(doc.root.children.map((c: DomNode) => (c.type === "element" ? c.tag : "#")), ["head", "body"]);
    assert.deepEqual(elementChildren(doc.body).map((e: DomElement) => e.tag), ["p"]);
    assert.equal(doc.nodes.some((n: DomNode) => n.type === "text" && /doctype/i.test(n.text)), false);
    const empty: DomDocument = parseDocument("");
    assert.equal(empty.body.children.length, 0);
});

test("engine/dom: explicit html/head/body merge attributes and keep content in body", () => {
    const doc: DomDocument = parseDocument(
        '<html lang="en"><head><title>t</title><meta charset="x"></head><body class="a  b a" id="z"><p>hi</p></body></html>',
    );
    assert.equal(doc.root.attrs.lang, "en");
    assert.deepEqual(doc.body.classList, ["a", "b"]);
    assert.equal(doc.body.attrs.id, "z");
    assert.equal(byTag(doc, "title").length + byTag(doc, "meta").length, 0);
    assert.equal(byTag(doc, "body").length, 1);
});

test("engine/dom: attrs lowercase, decoded, classList deduped", () => {
    const doc: DomDocument = parseDocument('<div CLASS="x  y\tx" ID=i Data-A="a&amp;b" hidden style="color:red"></div>');
    const div: DomElement = byTag(doc, "div")[0];
    assert.deepEqual(div.attrs, { class: "x  y\tx", id: "i", "data-a": "a&b", hidden: "", style: "color:red" });
    assert.deepEqual(div.classList, ["x", "y"]);
});

test("engine/dom: <style> collected in order, <link> kept, script and comments dropped", () => {
    const doc: DomDocument = parseDocument(
        '<link rel="stylesheet" href="a.css"><style>a > b { color: red }</style><!-- c --><p>x<script>var a = "<p>";</script></p>' +
            "<style>p{}</style>",
    );
    assert.deepEqual(doc.styles, ["a > b { color: red }", "p{}"]);
    assert.equal(byTag(doc, "link")[0].attrs.href, "a.css");
    assert.equal(byTag(doc, "script").length, 0);
    assert.equal(textOf(byTag(doc, "p")[0]), "x");
});

test("engine/dom: radio inputs and labels are kept with their attributes", () => {
    const doc: DomDocument = parseDocument(
        '<input type="radio" name="t" id="r1" checked><label for="r1" class="tab">One</label><button type="button">go</button>',
    );
    const input: DomElement = byTag(doc, "input")[0];
    assert.equal(input.attrs.type, "radio");
    assert.equal(input.attrs.name, "t");
    assert.equal(input.attrs.checked, "");
    assert.equal(input.children.length, 0);
    const label: DomElement = byTag(doc, "label")[0];
    assert.equal(label.attrs.for, "r1");
    assert.equal(textOf(label), "One");
    assert.equal(byTag(doc, "button").length, 1);
});

test("engine/dom: entities decoded once, nbsp kept", () => {
    const doc: DomDocument = parseDocument("<p>&lt;a&gt; &amp;#39; &#39; &nbsp;x &rarr; &#x2713;</p>");
    assert.equal(textOf(doc.body), "<a> &#39; ' \u00a0x \u2192 \u2713");
});

test("engine/dom: whitespace preserved raw, adjacent text merged", () => {
    const doc: DomDocument = parseDocument("<p>  a \n  b  </p>  <p>c</p>");
    assert.equal(textOf(byTag(doc, "p")[0]), "  a \n  b  ");
    assert.equal(doc.body.children[1].type, "text");
});

test("engine/dom: pre and textarea drop one leading newline, textarea is raw text", () => {
    const doc: DomDocument = parseDocument("<pre>\n\nx &lt; y</pre><textarea>\n<b>&amp;</textarea>");
    assert.equal(textOf(byTag(doc, "pre")[0]), "\nx < y");
    assert.equal(textOf(byTag(doc, "textarea")[0]), "<b>&");
    assert.equal(byTag(doc, "b").length, 0);
});

test("engine/dom: implied end tags (p, li, dt/dd, tr/td, option)", () => {
    const doc: DomDocument = parseDocument(
        "<p>a<p>b<div>c</div><ul><li>1<li>2<ul><li>x</ul><li>3</ul><dl><dt>t<dd>d<dt>u</dl>" +
            "<table><tr><td>1<td>2<tr><td>3</table><select><option>a<option>b</select>",
    );
    assert.deepEqual(byTag(doc, "p").map(textOf), ["a", "b"]);
    assert.equal(byTag(doc, "div")[0].id > byTag(doc, "p")[1].id, true);
    const outer: DomElement = byTag(doc, "ul")[0];
    assert.deepEqual(elementChildren(outer).map((e: DomElement) => e.tag), ["li", "li", "li"]);
    assert.equal(byTag(doc, "dt").length, 2);
    assert.equal(elementChildren(byTag(doc, "dl")[0]).length, 3);
    const trs: DomElement[] = byTag(doc, "tr");
    assert.deepEqual(trs.map((t: DomElement) => elementChildren(t).length), [2, 1]);
    assert.deepEqual(elementChildren(byTag(doc, "select")[0]).map(textOf), ["a", "b"]);
});

test("engine/dom: rows and cells directly under a table get the implied tbody (and tr)", () => {
    const doc: DomDocument = parseDocument(
        "<table><tr><td>1<tr><td>2</table><table><thead><tr><th>h</thead><tr><td>3</table><table><tbody><td>c</table>" +
            "<table><caption>c</caption><tbody><tr><td>x</table>",
    );
    const tables: DomElement[] = byTag(doc, "table");
    assert.deepEqual(elementChildren(tables[0]).map((e: DomElement) => e.tag), ["tbody"]);
    assert.deepEqual(elementChildren(elementChildren(tables[0])[0]).map((e: DomElement) => e.tag), ["tr", "tr"]);
    assert.deepEqual(elementChildren(tables[1]).map((e: DomElement) => e.tag), ["thead", "tbody"]);
    assert.deepEqual(elementChildren(elementChildren(tables[2])[0]).map((e: DomElement) => e.tag), ["tr"]);
    assert.deepEqual(elementChildren(tables[3]).map((e: DomElement) => e.tag), ["caption", "tbody"]);
    assert.equal(byTag(doc, "tbody").length, 4);
});

test("engine/dom: void elements have no children and misnested end tags are tolerated", () => {
    const doc: DomDocument = parseDocument("<p>a<br>b<img src=x>c<b>d<i>e</b>f</i>g</p></div></span>");
    assert.equal(byTag(doc, "br")[0].children.length, 0);
    assert.equal(textOf(byTag(doc, "p")[0]), "abcdefg");
});

test("engine/dom: malformed HTML never throws", () => {
    const junk: string[] = [
        "<", "<<>>", "<div", "<div class=", '<a href="x', "</", "</p></p>", "<p><", "<!--", "<!-- x", "<![CDATA[x]]>",
        "<?xml version='1.0'?><p>x", "<script>", "<style>a{", "&", "&#xZZ;", "<div>".repeat(5000), "\0\u0001<b>",
        "<table><td>x</tr></table></td>", "<html><body><html><body>x",
    ];
    for (const s of junk) {
        const doc: DomDocument = parseDocument(s);
        assert.equal(doc.root.tag, "html", s.slice(0, 20));
        assert.equal(doc.nodes.length, doc.parent.length);
    }
    assert.doesNotThrow(() => parseDocument(undefined as unknown as string));
});
