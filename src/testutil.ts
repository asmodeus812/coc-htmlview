/**
 * Test-only helpers shared by the engine's unit tests (dom, css, interact). Not imported by runtime code, so it
 * stays out of the bundle; layout's fixtures live in engine/layout/testkit.ts.
 */
import * as assert from "node:assert/strict";
import type { DomDocument, DomElement, DomNode } from "./engine/dom";

/** The element with attribute `id`; fails the test when there is none. */
export function byId(doc: DomDocument, id: string): DomElement {
    const el: DomNode | undefined = doc.nodes.find((n: DomNode) => n.type === "element" && n.attrs.id === id);
    assert.ok(el && el.type === "element", "no element #" + id);
    return el as DomElement;
}

/** Every element with tag `tag`, in document order. */
export function byTag(doc: DomDocument, tag: string): DomElement[] {
    return doc.nodes.filter((n: DomNode): n is DomElement => n.type === "element" && n.tag === tag);
}
