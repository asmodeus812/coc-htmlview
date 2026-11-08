/** Tree builder: tokens to a numbered DOM with implied html/head/body, auto-closing and dropped elements. */
import type { DomDocument, DomNode } from "./index";
import { tokenize } from "./tokenize";

/** Elements without content or end tag. */
const VOID: ReadonlySet<string> = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);

/** Start tags that close an open `<p>`. */
const CLOSES_P: ReadonlySet<string> = new Set([
    "address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figcaption", "figure", "footer",
    "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "main", "menu", "nav", "ol", "p", "pre",
    "section", "table", "ul", "li", "dt", "dd", "tr", "td", "th", "thead", "tbody", "tfoot",
]);

/** Elements that stop the search for an implicitly closed element (scope boundaries). */
const BOUNDARY: ReadonlySet<string> = new Set([
    "html", "body", "table", "td", "th", "caption", "button", "ul", "ol", "dl", "select", "template", "object",
]);

/** Per start tag: the open elements it implicitly closes and the boundaries its search stops at. */
const AUTO_CLOSE: Readonly<Record<string, { closes: readonly string[]; stop: readonly string[] }>> = {
    li: { closes: ["li"], stop: ["ul", "ol", "table", "td", "th", "body", "html"] },
    dt: { closes: ["dt", "dd"], stop: ["dl", "table", "td", "th", "body", "html"] },
    dd: { closes: ["dt", "dd"], stop: ["dl", "table", "td", "th", "body", "html"] },
    tr: { closes: ["tr", "td", "th"], stop: ["table", "thead", "tbody", "tfoot", "body", "html"] },
    td: { closes: ["td", "th"], stop: ["tr", "table", "body", "html"] },
    th: { closes: ["td", "th"], stop: ["tr", "table", "body", "html"] },
    thead: { closes: ["thead", "tbody", "tfoot", "tr", "td", "th"], stop: ["table", "body", "html"] },
    tbody: { closes: ["thead", "tbody", "tfoot", "tr", "td", "th"], stop: ["table", "body", "html"] },
    tfoot: { closes: ["thead", "tbody", "tfoot", "tr", "td", "th"], stop: ["table", "body", "html"] },
    option: { closes: ["option"], stop: ["select", "datalist", "body", "html"] },
    optgroup: { closes: ["option", "optgroup"], stop: ["select", "body", "html"] },
};

/** Table row groups (a `tr` is implied for a cell directly inside one). */
const ROW_GROUPS: ReadonlySet<string> = new Set(["thead", "tbody", "tfoot"]);

/** Head-level elements kept while the document is still in the head (`style`, `link`; the rest is dropped). */
const HEAD_ONLY: ReadonlySet<string> = new Set(["title", "meta", "base", "style", "link", "script", "noscript", "template"]);

/** Elements whose content is dropped entirely. */
const DROPPED: ReadonlySet<string> = new Set(["script", "title", "meta", "base", "noscript", "template"]);

export interface MutElement {
    type: "element";
    id: number;
    tag: string;
    attrs: Record<string, string>;
    classList: string[];
    children: MutNode[];
}

export interface MutText {
    type: "text";
    id: number;
    text: string;
}

export type MutNode = MutElement | MutText;

export function newElement(tag: string, attrs: Record<string, string>): MutElement {
    const cls: string[] = [];
    const classes: string[] = (attrs.class ?? "").split(/[ \t\n\r\f]+/);
    for (const c of classes) {
        if (c !== "" && !cls.includes(c)) {
            cls.push(c);
        }
    }
    return { type: "element", id: 0, tag, attrs, classList: cls, children: [] };
}

/** Tree-builder state. */
interface Builder {
    html: MutElement;
    head: MutElement;
    body: MutElement;
    stack: MutElement[];
    inBody: boolean;
    /** Depth of a dropped element being skipped (its tokens are ignored until it closes). */
    skip: string | undefined;
    skipDepth: number;
    styles: string[];
    /** The element whose first text must lose one leading newline. */
    trimNext: MutElement | undefined;
}

function current(b: Builder): MutElement {
    return b.stack[b.stack.length - 1];
}

function enterBody(b: Builder): void {
    if (!b.inBody) {
        b.inBody = true;
        b.stack.length = 0;
        b.stack.push(b.html, b.body);
    }
}

/** Closes the outermost open element named in `closes` that lies above the nearest boundary in `stop`. */
function closeUntil(b: Builder, closes: readonly string[], stop: readonly string[]): void {
    let found: number = -1;
    let blocked: boolean = false;
    for (let i: number = b.stack.length - 1; i >= 2 && !blocked; i--) {
        const tag: string = b.stack[i].tag;
        if (closes.includes(tag)) {
            found = i;
        } else if (stop.includes(tag)) {
            blocked = true;
        }
    }
    if (found >= 0) {
        b.stack.length = found;
    }
}

/** Inserts the implied `tbody` (and `tr`) a row or cell start tag needs directly under a `table` or row group. */
function impliedTableParts(b: Builder, tag: string): void {
    const isCell: boolean = tag === "td" || tag === "th";
    if ((tag === "tr" || isCell) && current(b).tag === "table") {
        const tbody: MutElement = newElement("tbody", {});
        current(b).children.push(tbody);
        b.stack.push(tbody);
    }
    if (isCell && ROW_GROUPS.has(current(b).tag)) {
        const tr: MutElement = newElement("tr", {});
        current(b).children.push(tr);
        b.stack.push(tr);
    }
}

function appendText(b: Builder, text: string): void {
    const parent: MutElement = current(b);
    let value: string = text;
    if (b.trimNext === parent) {
        value = value.replace(/^\r?\n/, "");
        b.trimNext = undefined;
    }
    const last: MutNode | undefined = parent.children[parent.children.length - 1];
    if (value === "") {
        // dropped
    } else if (last !== undefined && last.type === "text") {
        last.text += value;
    } else {
        parent.children.push({ type: "text", id: 0, text: value });
    }
}

function onText(b: Builder, text: string): void {
    if (b.skip !== undefined) {
        // inside a dropped element
    } else if (!b.inBody && current(b) === b.head) {
        if (/[^ \t\n\r\f]/.test(text)) {
            enterBody(b);
            appendText(b, text);
        }
    } else if (!b.inBody && current(b) === b.html) {
        if (/[^ \t\n\r\f]/.test(text)) {
            enterBody(b);
            appendText(b, text);
        }
    } else {
        appendText(b, text);
    }
}

function onOpen(b: Builder, tag: string, attrs: Record<string, string>): void {
    if (b.skip !== undefined) {
        b.skipDepth += tag === b.skip ? 1 : 0;
    } else if (tag === "html" || tag === "head" || tag === "body") {
        const target: MutElement = tag === "html" ? b.html : tag === "head" ? b.head : b.body;
        for (const k of Object.keys(attrs)) {
            if (!Object.prototype.hasOwnProperty.call(target.attrs, k)) {
                target.attrs[k] = attrs[k];
            }
        }
        target.classList = newElement(tag, target.attrs).classList;
        if (tag === "body") {
            enterBody(b);
        } else if (tag === "head" && !b.inBody) {
            b.stack.length = 0;
            b.stack.push(b.html, b.head);
        }
    } else if (DROPPED.has(tag)) {
        if (!VOID.has(tag)) {
            b.skip = tag;
            b.skipDepth = 1;
        }
    } else {
        if (!b.inBody && !HEAD_ONLY.has(tag)) {
            enterBody(b);
        }
        if (b.inBody) {
            if (CLOSES_P.has(tag)) {
                closeUntil(b, ["p"], [...BOUNDARY]);
            }
            const rule: { closes: readonly string[]; stop: readonly string[] } | undefined = AUTO_CLOSE[tag];
            if (rule !== undefined) {
                closeUntil(b, rule.closes, rule.stop);
            }
        } else if (current(b) === b.html) {
            b.stack.push(b.head);
        }
        if (b.inBody) {
            impliedTableParts(b, tag);
        }
        const el: MutElement = newElement(tag, attrs);
        current(b).children.push(el);
        if (!VOID.has(tag)) {
            b.stack.push(el);
            b.trimNext = tag === "pre" || tag === "textarea" ? el : undefined;
        }
    }
}

function onClose(b: Builder, tag: string): void {
    if (b.skip !== undefined) {
        b.skipDepth -= tag === b.skip ? 1 : 0;
        if (b.skipDepth <= 0) {
            b.skip = undefined;
        }
    } else if (tag === "style") {
        const el: MutElement | undefined = b.stack[b.stack.length - 1];
        if (el !== undefined && el.tag === "style") {
            b.stack.pop();
        }
    } else if (!VOID.has(tag) && tag !== "html" && tag !== "head" && tag !== "body") {
        let i: number = b.stack.length - 1;
        while (i >= 2 && b.stack[i].tag !== tag) {
            i--;
        }
        if (i >= 2) {
            b.stack.length = i;
        }
    }
}

/** Assigns preorder ids and fills `nodes`, `parent` and `styles` (iterative). */
function numberNodes(b: Builder): { nodes: DomNode[]; parent: number[]; styles: string[] } {
    const nodes: DomNode[] = [];
    const parent: number[] = [];
    const styles: string[] = [];
    const work: { node: MutNode; parent: number }[] = [{ node: b.html, parent: -1 }];
    while (work.length > 0) {
        const item: { node: MutNode; parent: number } = work.pop() as { node: MutNode; parent: number };
        const id: number = nodes.length;
        item.node.id = id;
        nodes.push(item.node);
        parent.push(item.parent);
        if (item.node.type === "element") {
            if (item.node.tag === "style") {
                styles.push(item.node.children.map((c: MutNode) => (c.type === "text" ? c.text : "")).join(""));
            }
            for (let i: number = item.node.children.length - 1; i >= 0; i--) {
                work.push({ node: item.node.children[i], parent: id });
            }
        }
    }
    return { nodes, parent, styles };
}

export function build(html: string): DomDocument {
    const root: MutElement = newElement("html", {});
    const head: MutElement = newElement("head", {});
    const body: MutElement = newElement("body", {});
    root.children.push(head, body);
    const b: Builder = {
        html: root, head, body, stack: [root], inBody: false, skip: undefined, skipDepth: 0, styles: [],
        trimNext: undefined,
    };
    for (const t of tokenize(html)) {
        if (t.kind === "open") {
            onOpen(b, t.tag, t.attrs);
        } else if (t.kind === "close") {
            onClose(b, t.tag);
        } else {
            onText(b, t.text);
        }
    }
    const done: { nodes: DomNode[]; parent: number[]; styles: string[] } = numberNodes(b);
    return { root, body, nodes: done.nodes, parent: done.parent, styles: done.styles };
}
