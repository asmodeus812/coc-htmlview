/**
 * buildBoxes: StyledTree → box tree. Driven by `ComputedStyle.display` and the layout hints only (never tags).
 *
 * An element's box carries the element's attributes (`BoxBase.attrs`), plus two derived ones that depend on other
 * elements: `data-htmlview-lang` (the code language of a code block) and `data-htmlview-toggle` (the radio group of
 * a toggle label). Anonymous boxes and text have none.
 */
import type { ComputedStyle, StyledElement, StyledNode, StyledPseudo, StyledTree } from "../style";
import type { DomElement } from "../dom";
import { LayoutHint, markerText } from "../style";
import type { AtomicInlineBox, BlockBox, Box, BreakBox, FlexRowBox, InlineBox, ListItemBox, MarkerBox, TableBox, TableCellBox, TableRowBox, TextBox } from "./index";

/** Attribute layout derives for a box (see {@link boxAttrs}): the code language of a `--htmlview-code: block` box. */
export const ATTR_LANG = "data-htmlview-lang";
/** Derived attribute: the radio group name (or `checkbox`) of a `--htmlview-toggle: label` box; its key is the `for` attribute. */
export const ATTR_TOGGLE = "data-htmlview-toggle";

/** Build context: the StyledElements by `id` attribute (for label → control resolution). */
interface BuildCtx {
    byId: Map<string, StyledElement>;
}

function indexIds(el: StyledElement, out: Map<string, StyledElement>): void {
    const id: string | undefined = el.element.attrs.id;
    if (id !== undefined && id !== "" && !out.has(id)) {
        out.set(id, el);
    }
    for (const child of el.children) {
        if (child.kind === "element") {
            indexIds(child, out);
        }
    }
}

/** True for display values that generate block-level boxes. */
function isBlockLevel(display: string): boolean {
    return display !== "inline" && display !== "inline-block" && display !== "none" && display !== "contents";
}

function blockLevelBox(box: Box): boolean {
    let out: boolean;
    if (box.kind === "text" || box.kind === "break" || box.kind === "inline" || box.kind === "atomic" || box.kind === "marker") {
        out = false;
    } else {
        out = true;
    }
    return out;
}

function hasCode(el: DomElement): string | undefined {
    const fromClass: string | undefined = el.classList
        .map((c: string): RegExpExecArray | null => /^(?:language|lang)-(.+)$/.exec(c))
        .filter((m: RegExpExecArray | null): boolean => m !== null)
        .map((m: RegExpExecArray | null): string => (m as RegExpExecArray)[1])[0];
    const attr: string = el.attrs["data-lang"] ?? el.attrs["data-language"] ?? el.attrs.lang ?? "";
    return attr !== "" ? attr : fromClass;
}

function codeLang(el: StyledElement): string {
    const own: string | undefined = hasCode(el.element);
    const inner: string | undefined = el.children
        .filter((c: StyledNode): c is StyledElement => c.kind === "element")
        .map((c: StyledElement): string | undefined => hasCode(c.element))
        .find((l: string | undefined): boolean => l !== undefined);
    return own ?? inner ?? "";
}

/** The box's attributes: the element's own plus the derived `data-htmlview-lang` and `data-htmlview-toggle`. */
function boxAttrs(el: StyledElement, ctx: BuildCtx): Readonly<Record<string, string>> {
    const attrs: Readonly<Record<string, string>> = el.element.attrs;
    const extra: Record<string, string> = {};
    const toggle: string | undefined = el.style.custom[LayoutHint.toggle];
    if (el.style.custom[LayoutHint.code] === "block") {
        extra[ATTR_LANG] = codeLang(el);
    }
    if (toggle !== undefined && toggle.trim() === "label" && attrs.for !== undefined) {
        const control: StyledElement | undefined = ctx.byId.get(attrs.for);
        const type: string = control !== undefined ? (control.element.attrs.type ?? "").toLowerCase() : "";
        if (type === "radio") {
            extra[ATTR_TOGGLE] = control?.element.attrs.name ?? attrs.for;
        } else if (type === "checkbox") {
            extra[ATTR_TOGGLE] = "checkbox";
        }
    }
    return Object.keys(extra).length > 0 ? { ...attrs, ...extra } : attrs;
}

/** Ordinal of each list-item child of `parent` (implicit list-item counter, `start`/`reversed`/`value`). */
function ordinals(parent: StyledElement): Map<StyledElement, number> {
    const items: StyledElement[] = parent.children.filter((c: StyledNode): c is StyledElement => c.kind === "element" && c.style.display === "list-item");
    const reversed: boolean = parent.element.attrs.reversed !== undefined;
    const start: number = parseInt(parent.element.attrs.start ?? "", 10);
    let n: number = Number.isNaN(start) ? (reversed ? items.length : 1) : start;
    const out: Map<StyledElement, number> = new Map();
    for (const item of items) {
        const value: number = parseInt(item.element.attrs.value ?? "", 10);
        n = Number.isNaN(value) ? n : value;
        out.set(item, n);
        n += reversed ? -1 : 1;
    }
    return out;
}

function pseudoBox(p: StyledPseudo): Box[] {
    let out: Box[];
    if (p.text === "" || p.style.display === "none") {
        out = [];
    } else {
        const text: TextBox = { kind: "text", style: p.style, paint: [], text: p.text };
        if (isBlockLevel(p.style.display)) {
            out = [{ kind: "block", style: p.style, paint: p.paint, children: [text] }];
        } else {
            out = [{ kind: "inline", style: p.style, paint: p.paint, children: [text], pseudo: p.pseudo === "marker" ? undefined : p.pseudo }];
        }
    }
    return out;
}

function markerBox(el: StyledElement, ordinal: number): MarkerBox | undefined {
    const m: StyledPseudo | undefined = el.marker;
    const text: string = m !== undefined ? m.text : markerText(ordinal, el.style.listStyleType);
    const style: ComputedStyle = m !== undefined ? m.style : el.style;
    let out: MarkerBox | undefined;
    if (text !== "") {
        out = { kind: "marker", element: el.element.id, style, paint: m !== undefined ? m.paint : [], text, position: el.style.listStylePosition };
    } else {
        out = undefined;
    }
    return out;
}

const ZERO_EDGES = { top: 0, right: 0, bottom: 0, left: 0 };

/** Style of an anonymous box inside a box styled `style`: inherited values kept, box properties and hints reset. */
export function anonStyle(style: ComputedStyle): ComputedStyle {
    const hints: Set<string> = new Set<string>(Object.values(LayoutHint));
    const custom: Record<string, string> = {};
    for (const [k, v] of Object.entries(style.custom)) {
        if (!hints.has(k)) {
            custom[k] = v;
        }
    }
    const none: ComputedStyle["border"]["top"] = { style: "none", width: 0, color: style.color };
    return {
        ...style,
        display: "block",
        margin: ZERO_EDGES,
        padding: ZERO_EDGES,
        border: { top: none, right: none, bottom: none, left: none },
        backgroundColor: { hex: "#000000", alpha: 0 },
        textDecoration: { underline: false, lineThrough: false, overline: false },
        content: undefined,
        counterReset: [],
        counterIncrement: [],
        counterSet: [],
        custom,
    };
}

/** True when `box` is an inline run made only of collapsible white space. */
function blankInline(box: Box): boolean {
    let out: boolean;
    if (box.kind === "text") {
        out = /^[ \t\n\r\f]*$/.test(box.text) && box.style.whiteSpace !== "pre" && box.style.whiteSpace !== "pre-wrap";
    } else {
        out = false;
    }
    return out;
}

/** Wraps inline runs among block children in anonymous blocks (blank runs dropped). */
function normalizeBlockChildren(children: Box[], style: ComputedStyle): Box[] {
    const anyBlock: boolean = children.some(blockLevelBox);
    let out: Box[];
    if (!anyBlock) {
        out = children;
    } else {
        out = [];
        let run: Box[] = [];
        const flush = (): void => {
            if (run.length > 0 && !run.every(blankInline)) {
                out.push({ kind: "block", style: anonStyle(style), paint: [], children: run, anonymous: true });
            }
            run = [];
        };
        for (const child of children) {
            if (blockLevelBox(child)) {
                flush();
                out.push(child);
            } else {
                run.push(child);
            }
        }
        flush();
    }
    return out;
}

/** Hides text of `visibility: hidden` content (keeps its cells). */
function visibleText(text: string, style: ComputedStyle): string {
    return style.visibility === "visible" ? text : text.replace(/[^\s]/gu, " ");
}

/** Boxes generated by `node` (zero for display none, several for display contents). */
function boxesOf(node: StyledNode, parentStyle: ComputedStyle, ctx: BuildCtx, ordinal: number): Box[] {
    let out: Box[];
    if (node.kind === "text") {
        out = node.text === "" ? [] : [{ kind: "text", style: parentStyle, paint: [], text: visibleText(node.text, parentStyle) }];
    } else if (node.style.display === "none") {
        out = [];
    } else if (node.style.display === "contents") {
        out = contentBoxes(node, ctx);
    } else {
        out = [elementBox(node, ctx, ordinal)];
    }
    return out;
}

/** ::before, children, ::after of `el` as boxes. */
function contentBoxes(el: StyledElement, ctx: BuildCtx): Box[] {
    const ords: Map<StyledElement, number> = ordinals(el);
    const out: Box[] = [];
    if (el.before !== undefined) {
        out.push(...pseudoBox(el.before));
    }
    for (const child of el.children) {
        out.push(...boxesOf(child, el.style, ctx, child.kind === "element" ? ords.get(child) ?? 1 : 1));
    }
    if (el.after !== undefined) {
        out.push(...pseudoBox(el.after));
    }
    return out;
}

function tableCell(children: Box[], style: ComputedStyle, el?: StyledElement, own?: ComputedStyle): TableCellBox {
    const colspan: number = parseInt(el?.element.attrs.colspan ?? "1", 10);
    const rowspan: number = parseInt(el?.element.attrs.rowspan ?? "1", 10);
    return {
        kind: "table-cell",
        element: el?.element.id,
        style: own ?? style,
        paint: el?.paint ?? [],
        colspan: Number.isNaN(colspan) || colspan < 1 ? 1 : Math.min(colspan, 1000),
        rowspan: Number.isNaN(rowspan) || rowspan < 1 ? 1 : rowspan,
        children: normalizeBlockChildren(children, own ?? style),
    };
}

/** Cells of a row: table-cell children as cells, any other run wrapped in an anonymous cell. */
function rowCells(boxes: Box[], style: ComputedStyle): TableCellBox[] {
    const out: TableCellBox[] = [];
    let run: Box[] = [];
    const flush = (): void => {
        if (run.length > 0 && !run.every(blankInline)) {
            out.push(tableCell(run, anonStyle(style)));
        }
        run = [];
    };
    for (const box of boxes) {
        if (box.kind === "table-cell") {
            flush();
            out.push(box);
        } else {
            run.push(box);
        }
    }
    flush();
    return out;
}

/** Builds a table: captions, rows in visual order (header groups, bodies and loose rows, footers). */
function tableBox(el: StyledElement, style: ComputedStyle, ctx: BuildCtx): TableBox {
    const captions: BlockBox[] = [];
    const header: TableRowBox[] = [];
    const body: TableRowBox[] = [];
    const footer: TableRowBox[] = [];
    let loose: Box[] = [];
    const flushLoose = (): void => {
        if (loose.length > 0 && !loose.every(blankInline)) {
            body.push({ kind: "table-row", style: anonStyle(style), paint: [], group: "body", cells: rowCells(loose, style) });
        }
        loose = [];
    };
    const ords: Map<StyledElement, number> = ordinals(el);
    const kids: StyledNode[] = el.children;
    for (const child of kids) {
        const d: string = child.kind === "element" ? child.style.display : "inline";
        if (child.kind === "element" && (d === "table-header-group" || d === "table-row-group" || d === "table-footer-group")) {
            flushLoose();
            const target: TableRowBox[] = d === "table-header-group" ? header : d === "table-footer-group" ? footer : body;
            const group: TableRowBox["group"] = d === "table-header-group" ? "header" : d === "table-footer-group" ? "footer" : "body";
            const rows: Box[] = contentBoxes(child, ctx);
            let rowRun: Box[] = [];
            const flushRun = (): void => {
                if (rowRun.length > 0 && !rowRun.every(blankInline)) {
                    target.push({ kind: "table-row", style: anonStyle(child.style), paint: [], group, cells: rowCells(rowRun, child.style) });
                }
                rowRun = [];
            };
            for (const r of rows) {
                if (r.kind === "table-row") {
                    flushRun();
                    target.push({ ...r, group });
                } else {
                    rowRun.push(r);
                }
            }
            flushRun();
        } else if (child.kind === "element" && d === "table-caption") {
            flushLoose();
            const cap: Box = elementBox(child, ctx, 1);
            captions.push(cap.kind === "block" ? cap : { kind: "block", style: anonStyle(child.style), paint: [], children: [cap] });
        } else {
            const boxes: Box[] = boxesOf(child, el.style, ctx, child.kind === "element" ? ords.get(child) ?? 1 : 1);
            for (const b of boxes) {
                if (b.kind === "table-row") {
                    flushLoose();
                    body.push(b);
                } else {
                    loose.push(b);
                }
            }
        }
    }
    flushLoose();
    return { kind: "table", element: el.element.id, style, paint: el.paint, captions, rows: header.concat(body, footer) };
}

/** The box of one element (display not none/contents). */
function elementBox(el: StyledElement, ctx: BuildCtx, ordinal: number): Box {
    const style: ComputedStyle = el.style;
    const attrs: Readonly<Record<string, string>> = boxAttrs(el, ctx);
    const d: string = el.style.display;
    const brk: string | undefined = el.style.custom[LayoutHint.break];
    const replaced: string | undefined = el.style.custom[LayoutHint.replaced];
    const base: { element: number; style: ComputedStyle; paint: string[]; attrs: Readonly<Record<string, string>> } = { element: el.element.id, style, paint: el.paint, attrs };
    let out: Box;
    if (brk !== undefined && (brk.trim() === "line" || brk.trim() === "opportunity")) {
        const b: BreakBox = { ...base, kind: "break", forced: brk.trim() === "line" };
        out = b;
    } else if (replaced !== undefined && replaced.trim() !== "" && replaced.trim() !== "none") {
        const a: AtomicInlineBox = { ...base, kind: "atomic", children: [], replacedText: el.element.attrs[replaced.trim()] ?? "" };
        out = isBlockLevel(d) ? { ...base, kind: "block", children: [a] } : a;
    } else if (d === "table") {
        out = tableBox(el, style, ctx);
    } else if (d === "table-row") {
        const r: TableRowBox = { ...base, kind: "table-row", group: "body", cells: rowCells(contentBoxes(el, ctx), style) };
        out = r;
    } else if (d === "table-cell") {
        out = tableCell(contentBoxes(el, ctx), style, el, style);
    } else if (d === "flex") {
        const items: Box[] = normalizeBlockChildren(contentBoxes(el, ctx), style).map((b: Box): Box =>
            blockLevelBox(b) ? b : { kind: "block", style: anonStyle(style), paint: [], children: [b], anonymous: true },
        );
        const f: FlexRowBox = { ...base, kind: "flex-row", items: items.filter((b: Box): boolean => !(b.kind === "block" && b.anonymous === true && b.children.every(blankInline))) };
        out = f;
    } else if (d === "list-item") {
        const li: ListItemBox = { ...base, kind: "list-item", marker: markerBox(el, ordinal), children: normalizeBlockChildren(contentBoxes(el, ctx), style) };
        out = li;
    } else if (d === "inline-block") {
        const a: AtomicInlineBox = { ...base, kind: "atomic", children: normalizeBlockChildren(contentBoxes(el, ctx), style) };
        out = a;
    } else if (d === "inline") {
        const children: Box[] = contentBoxes(el, ctx);
        // an inline containing blocks is treated as a block (simplified block-in-inline split)
        const inl: InlineBox = { ...base, kind: "inline", children };
        out = children.some(blockLevelBox) ? { ...base, kind: "block", children: normalizeBlockChildren(children, style) } : inl;
    } else {
        const blk: BlockBox = { ...base, kind: "block", children: normalizeBlockChildren(contentBoxes(el, ctx), style) };
        out = blk;
    }
    return out.attrs === undefined ? { ...out, attrs } : out;
}

/** StyledTree → box tree; the root is always a block box. */
export function build(styled: StyledTree): BlockBox {
    const ctx: BuildCtx = { byId: new Map() };
    indexIds(styled.root, ctx.byId);
    const root: Box = styled.root.style.display === "none" ? { kind: "block", style: anonStyle(styled.root.style), paint: [], children: [] } : elementBox(styled.root, ctx, 1);
    let out: BlockBox;
    if (root.kind === "block") {
        out = root;
    } else {
        out = { kind: "block", style: anonStyle(root.style), paint: [], children: normalizeBlockChildren([root], root.style), anonymous: true };
    }
    return out;
}
