/** Inline formatting: flow wrapping of inline content, paint marks per range, atomic inlines and inline markers. */
import { displayWidth } from "../../common";
import type { ComputedStyle } from "../style";
import { LayoutHint } from "../style";
import type { Fragment, PendingMarker, Run } from "./canvas";
import { ensureLine, flush, put, shiftPlaced } from "./canvas";
import { Flow, lineScreenWidth, lineText, wrapFlow } from "./flow";
import type { FlowItem, FlowLine } from "./flow";
import { maxContent, fragment } from "./flex";
import type { AtomicInlineBox, BlockBox, Box, CellRange, PlacedBox } from "./index";
import { childDepth, markerDisplay, markerGroups, paintRange, writeOutsideMarker } from "./place";

function transform(text: string, style: ComputedStyle): string {
    let out: string;
    if (style.textTransform === "uppercase") {
        out = text.toUpperCase();
    } else if (style.textTransform === "lowercase") {
        out = text.toLowerCase();
    } else if (style.textTransform === "capitalize") {
        out = text.replace(/(^|[\s\-(["'])(\p{L})/gu, (_m: string, a: string, b: string): string => a + b.toUpperCase());
    } else {
        out = text;
    }
    return out;
}


// ---------------------------------------------------------------- inline formatting

/** A recorded span of the flow: one box, its item range, its nested spans. */
interface Span {
    box: Box;
    start: number;
    end: number;
    depth: number;
    children: Span[];
    /** Atomic content: the fragment and the flow item where each of its lines starts. */
    frag?: Fragment;
    fragStarts?: number[];
    /** A marker drawn as inline virtual text (zero buffer cells). */
    virtualMarker?: boolean;
}

interface InlineCtx {
    run: Run;
    flow: Flow;
    width: number;
}

function inlineEdges(flow: Flow, cells: number): void {
    if (cells > 0) {
        flow.atomic(" ".repeat(cells));
    }
}

function atomicFragment(box: AtomicInlineBox, ictx: InlineCtx, depth: number): Fragment {
    const style: ComputedStyle = { ...box.style, margin: { top: 0, right: 0, bottom: 0, left: 0 } };
    const block: BlockBox = { kind: "block", element: box.element, style, paint: box.paint, children: box.children };
    const fit: number = Math.max(1, Math.min(ictx.width, maxContent(ictx.run.opts, block, depth)));
    return fragment(ictx.run.opts, [block], fit, depth);
}

/** Appends the boxes to the flow, recording spans. */
function walk(ictx: InlineCtx, boxes: readonly Box[], depth: number, out: Span[]): void {
    const flow: Flow = ictx.flow;
    for (const box of boxes) {
        const start: number = flow.pos;
        const span: Span = { box, start, end: start, depth, children: [] };
        if (box.kind === "text") {
            flow.text(transform(box.text, box.style), box.style.whiteSpace, box.style.tabSize > 0 ? box.style.tabSize : ictx.run.opts.tabstop);
        } else if (box.kind === "break") {
            if (box.forced) {
                flow.hardBreak();
            } else {
                flow.opportunity();
            }
        } else if (box.kind === "inline") {
            inlineEdges(flow, Math.max(0, box.style.margin.left));
            span.start = flow.pos;
            inlineEdges(flow, box.style.padding.left);
            walk(ictx, box.children, childDepth(box, depth), span.children);
            inlineEdges(flow, box.style.padding.right);
            span.end = flow.pos;
            const linkAttr: string | undefined = box.style.custom[LayoutHint.link];
            const href: string | undefined = linkAttr !== undefined ? box.attrs?.[linkAttr.trim()] : undefined;
            if (href !== undefined && !href.startsWith("#") && ictx.run.opts.showTarget) {
                flow.virtual(displayWidth(` ${ictx.run.opts.symbol} ${href}`));
            }
            inlineEdges(flow, Math.max(0, box.style.margin.right));
        } else if (box.kind === "atomic") {
            inlineEdges(flow, Math.max(0, box.style.margin.left));
            span.start = flow.pos;
            if (box.replacedText !== undefined) {
                flow.atomic(box.replacedText === "" ? "" : `${ictx.run.opts.image}[${box.replacedText}]`);
            } else {
                const frag: Fragment = atomicFragment(box, ictx, childDepth(box, depth));
                const starts: number[] = [];
                if (frag.lines.length > 1) {
                    flow.softBreak();
                }
                frag.lines.forEach((l: string, k: number): void => {
                    if (k > 0) {
                        flow.hardBreak();
                    }
                    starts.push(flow.pos);
                    flow.atomic(l);
                });
                span.frag = frag;
                span.fragStarts = starts;
            }
            span.end = flow.pos;
            if (span.frag !== undefined && span.frag.lines.length > 1) {
                flow.hardBreak();
            }
            inlineEdges(flow, Math.max(0, box.style.margin.right));
        } else if (box.kind === "marker") {
            const text: string = markerDisplay(box, ictx.run.opts);
            if (ictx.run.opts.virtual) {
                flow.virtual(displayWidth(text));
                span.virtualMarker = true;
            } else {
                flow.atomic(text);
            }
        }
        span.end = Math.max(span.end, flow.pos);
        if (box.kind === "inline" || box.kind === "atomic") {
            span.end = Math.min(span.end, flow.pos);
        }
        out.push(span);
    }
}

/** A wrapped line placed in the buffer: its items and the cell where it starts. */
interface PlacedLine {
    range: FlowLine;
    line: number;
    col: number;
    /** Buffer cell of each item index from range.start to range.end (inclusive end). */
    cells: number[];
}

function rangesOf(lines: readonly PlacedLine[], start: number, end: number): CellRange[] {
    const out: CellRange[] = [];
    for (const pl of lines) {
        const a: number = Math.max(start, pl.range.start);
        const b: number = Math.min(end, pl.range.end);
        if (a < b && pl.cells[b - pl.range.start] > pl.cells[a - pl.range.start]) {
            out.push({ line: pl.line, startCol: pl.col + pl.cells[a - pl.range.start], endCol: pl.col + pl.cells[b - pl.range.start] });
        }
    }
    return out;
}

function pointOf(lines: readonly PlacedLine[], pos: number): CellRange | undefined {
    const pl: PlacedLine | undefined = lines.find((l: PlacedLine): boolean => pos >= l.range.start && pos <= l.range.end);
    const col: number = pl !== undefined ? pl.col + pl.cells[pos - pl.range.start] : 0;
    return pl !== undefined ? { line: pl.line, startCol: col, endCol: col } : undefined;
}

/** Turns a span into a placed box (and its paint marks). */
function placeSpan(run: Run, span: Span, lines: readonly PlacedLine[], fallbackLine: number): PlacedBox {
    const box: Box = span.box;
    let ranges: CellRange[] = rangesOf(lines, span.start, span.end);
    const children: PlacedBox[] = span.children.map((c: Span): PlacedBox => placeSpan(run, c, lines, fallbackLine));
    if (span.virtualMarker === true) {
        const p: CellRange | undefined = pointOf(lines, span.start);
        ranges = p !== undefined ? [p] : [];
    }
    if (span.frag !== undefined && span.fragStarts !== undefined) {
        const frag: Fragment = span.frag;
        const starts: Array<CellRange | undefined> = span.fragStarts.map((s: number): CellRange | undefined => pointOf(lines, s));
        frag.marks.forEach((m): void => {
            const at: CellRange | undefined = starts[m.line];
            if (at !== undefined) {
                run.marks.push({ ...m, line: at.line, startCol: m.startCol + at.startCol, endCol: m.endCol + at.startCol });
            }
        });
        const first: CellRange | undefined = starts[0];
        frag.placed.forEach((p: PlacedBox): void => {
            shiftPlaced(p, first !== undefined ? first.line : fallbackLine, first !== undefined ? first.startCol : 0);
            children.push(p);
        });
    }
    if (box.kind !== "marker" && box.kind !== "text") {
        ranges.forEach((r: CellRange): void => paintRange(run, box.paint, span.depth, r));
    } else if (box.kind === "marker" && span.virtualMarker !== true) {
        ranges.forEach((r: CellRange): void => paintRange(run, markerGroups(box), span.depth, r));
    }
    const startLine: number = ranges.length > 0 ? ranges[0].line : children.length > 0 ? children[0].startLine : fallbackLine;
    const endLine: number = ranges.length > 0 ? ranges[ranges.length - 1].line : children.length > 0 ? children[children.length - 1].endLine : fallbackLine - 1;
    return {
        box,
        startLine,
        endLine,
        contentCol: ranges.length > 0 ? ranges[0].startCol : 0,
        width: ranges.reduce((acc: number, r: CellRange): number => Math.max(acc, r.endCol - r.startCol), 0),
        ranges,
        children,
    };
}

/** Inline formatting context of `boxes` in `[cx, cx + cw)`; flushes and writes lines only when not blank. */
export function placeInline(run: Run, boxes: readonly Box[], cx: number, cw: number, depth: number, block: ComputedStyle): PlacedBox[] {
    const flow: Flow = new Flow();
    const spans: Span[] = [];
    const ictx: InlineCtx = { run, flow, width: cw };
    const inside: PendingMarker[] = run.markers.filter((m: PendingMarker): boolean => m.box.position === "inside");
    const insideBoxes: Box[] = inside.map((m: PendingMarker): Box => m.box);
    walk(ictx, insideBoxes.concat(boxes), depth, spans);
    const wrapped: FlowLine[] = wrapFlow(flow, cw, run.opts.split);
    const items: FlowItem[] = flow.items;
    const placedLines: PlacedLine[] = [];
    let first: number = run.y;
    if (wrapped.length > 0 && !flow.isBlank()) {
        first = flush(run);
        wrapped.forEach((r: FlowLine, k: number): void => {
            const sw: number = lineScreenWidth(items, r);
            const free: number = Math.max(0, cw - sw);
            const off: number = block.textAlign === "center" ? Math.floor(free / 2) : block.textAlign === "right" ? free : 0;
            const cells: number[] = [0];
            for (let i = r.start; i < r.end; i++) {
                cells.push(cells[cells.length - 1] + items[i].w);
            }
            const text: string = lineText(items, r);
            ensureLine(run, first + k);
            if (text !== "") {
                put(run, first + k, cx + off, text);
            }
            placedLines.push({ range: r, line: first + k, col: cx + off, cells });
        });
        run.y = first + wrapped.length;
        const pendingOutside: PendingMarker[] = run.markers.filter((m: PendingMarker): boolean => m.box.position === "outside");
        pendingOutside.forEach((m: PendingMarker): void => writeOutsideMarker(run, m, first, false));
        run.markers = [];
    }
    const placed: PlacedBox[] = spans.map((s: Span): PlacedBox => placeSpan(run, s, placedLines, first));
    inside.forEach((m: PendingMarker, i: number): void => {
        const p: PlacedBox = placed[i];
        m.placed.ranges = p.ranges;
        m.placed.startLine = p.startLine;
        m.placed.endLine = p.endLine;
    });
    return placed.slice(inside.length);
}
