/**
 * HTML → a plain DOM. No semantic nodes: elements keep their tag, attributes and children exactly as the markup
 * says; what an element LOOKS like is decided later by the cascade (css/, style/), never here.
 *
 * Shape: a tree of plain objects without parent pointers (no cycles, JSON-safe, deep-equal-testable). Every node
 * has a document-order `id` (preorder index over ALL nodes, text included, root = 0); {@link DomDocument.nodes}
 * and {@link DomDocument.parent} index nodes by that id, which gives the css/ matcher O(1) parent and sibling
 * access without mutating the tree.
 *
 * Pure and synchronous; no nvim. Never throws (worst case: the text as a single text node).
 */

import type { MutElement, MutText } from "./build";
import { build, newElement } from "./build";

/** An element. Tags and attribute names are lowercase; attribute values are entity-decoded. */
export interface DomElement {
    type: "element";
    /** Preorder index in the document (see module doc). */
    id: number;
    /** Lowercase tag name (`"div"`, `"pre"`, `"input"`); unknown tags are kept as written (lowercased). */
    tag: string;
    /** All attributes, names lowercase, values decoded (`class`, `id`, `style`, `href`, `checked`, `data-*` …). */
    attrs: Readonly<Record<string, string>>;
    /** `class` split on ASCII whitespace, duplicates removed, order kept (derived from `attrs.class`). */
    classList: readonly string[];
    children: readonly DomNode[];
}

/**
 * A text node: decoded text (entities resolved, `&nbsp;` kept as U+00A0), whitespace exactly as in the source.
 * Collapsing is the job of `white-space` in layout/. Adjacent text is merged; empty text is dropped.
 */
export interface DomText {
    type: "text";
    id: number;
    text: string;
}

export type DomNode = DomElement | DomText;

/** The parsed document. */
export interface DomDocument {
    /** The `html` element (synthesised when the input is a fragment, as a browser does). */
    root: DomElement;
    /** The `body` element (synthesised when absent); fragments' content lands here. */
    body: DomElement;
    /** Every node by id (`nodes[n.id] === n`). */
    nodes: readonly DomNode[];
    /** Parent id per node id; `-1` for the root. */
    parent: readonly number[];
    /** Text of every `<style>` element in document order (author origin, after the given sheets). */
    styles: readonly string[];
}


/**
 * Parses `html` like a browser's tree builder, for the subset real documents use: implied `html`/`head`/`body`,
 * auto-closed `p`/`li`/`dt`/`dd`/`tr`/`td`/`th`/`option`, void elements, raw-text `script`/`style`/`textarea`,
 * the leading newline after `<pre>`/`<textarea>` dropped, misnested inline end tags tolerated. Comments,
 * `<script>`, `<head>` content other than `<style>`/`<link>`, doctype and processing instructions are dropped.
 *
 * Decisions: `<head>` is always the first child of `html` and keeps its `<style>` elements (text child raw) and
 * `<link>` elements (attributes intact, so a loader can read `rel`/`href`); ua.css hides them. `title`, `meta`,
 * `base`, `noscript` and `template` are dropped with their content. Never throws: on an internal failure the
 * input becomes one text node in `body`.
 */
export function parseDocument(input: string): DomDocument {
    const html: string = String(input ?? "");
    let doc: DomDocument;
    try {
        doc = build(html);
    } catch {
        const root: MutElement = newElement("html", {});
        const body: MutElement = newElement("body", {});
        root.children.push(body);
        if (html !== "") {
            body.children.push({ type: "text", id: 0, text: html });
        }
        root.id = 0;
        body.id = 1;
        const nodes: DomNode[] = [root, body];
        const parent: number[] = [-1, 0];
        if (html !== "") {
            (body.children[0] as MutText).id = 2;
            nodes.push(body.children[0]);
            parent.push(1);
        }
        doc = { root, body, nodes, parent, styles: [] };
    }
    return doc;
}

/** Children of `el` that are elements, in order. Convention helper for every part (pure). */
export function elementChildren(el: DomElement): DomElement[] {
    const out: DomElement[] = [];
    for (const child of el.children) {
        if (child.type === "element") {
            out.push(child);
        }
    }
    return out;
}

/** The parent element of node `id`, or undefined for the root. */
export function parentElement(doc: DomDocument, id: number): DomElement | undefined {
    const p: number = id >= 0 && id < doc.parent.length ? doc.parent[id] : -1;
    const node: DomNode | undefined = p >= 0 ? doc.nodes[p] : undefined;
    return node !== undefined && node.type === "element" ? node : undefined;
}
