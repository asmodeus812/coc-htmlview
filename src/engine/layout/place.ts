/**
 * placeBoxes: block formatting (margins → blank lines with collapsing, padding → indent and blank lines, borders
 * → box-drawing characters, background → marks over the box), inline formatting (flow wrapping, paint marks per
 * range), list markers, flex rows, and fragments for tables/flex/inline-blocks (laid out apart, then copied in).
 * Block formatting lives here; inline formatting is in ./inline, fragments and flex rows in ./flex.
 */
import { displayWidth, MarkPriority } from "../../common";
import type { ComputedStyle } from "../style";
import { hostRoles } from "../style/host";
import { anonStyle } from "./build";
import type { Opts, PendingMarker, Run } from "./canvas";
import { borderGroup, clipMarks, ensureLine, flush, glyphs, lineWidth, mark, newRun, put, trimLines } from "./canvas";
import { placeFlex } from "./flex";
import { paintPriority } from "./index";
import type { BlockBox, Box, CellRange, LayoutOptions, ListItemBox, MarkerBox, PlacedBox, PlacedTree, TableBox, TableRowBox } from "./index";
import { DEFAULT_LINK_TARGET } from "./index";
import { placeInline } from "./inline";
import { placeTable } from "./table";

const DEFAULT_BULLETS: readonly string[] = ["•", "◦", "▪"];

/** Resolves the options. */
export function resolveOpts(opts: LayoutOptions): Opts {
    const target: { show: boolean; symbol: string } = opts.linkTarget ?? DEFAULT_LINK_TARGET;
    return {
        width: Math.max(1, Math.floor(opts.width)),
        tabstop: Math.max(1, opts.tabstop),
        virtual: opts.virtual !== false,
        showTarget: target.show,
        symbol: target.symbol,
        rule: opts.icons?.rule ?? "─",
        bullets: opts.icons?.bullets,
        image: opts.icons?.image ?? "",
        split: true,
    };
}

/** True when the box takes part in block formatting. */
export function blockLevel(box: Box): boolean {
    return !(box.kind === "text" || box.kind === "break" || box.kind === "inline" || box.kind === "atomic" || box.kind === "marker");
}

/** Depth of the children of `box` (only element boxes count). */
export function childDepth(box: Box, depth: number): number {
    return box.element !== undefined ? depth + 1 : depth;
}

/** An empty placed box at the run's cursor. */
export function emptyPlaced(box: Box, run: Run, col: number, width: number): PlacedBox {
    return { box, startLine: run.y, endLine: run.y - 1, contentCol: col, width, ranges: [], children: [] };
}

/** The marker text with the user's bullets substituted for the default ones. */
export function markerDisplay(box: MarkerBox, opts: Opts): string {
    const bare: string = box.text.trimEnd();
    const idx: number = DEFAULT_BULLETS.indexOf(bare);
    const bullets: string[] | undefined = opts.bullets;
    return idx >= 0 && bullets !== undefined && bullets.length > 0 ? bullets[idx % bullets.length] + box.text.slice(bare.length) : box.text;
}

/** Groups painting a marker (its paint, else the list-marker role). */
export function markerGroups(box: MarkerBox): string[] {
    return box.paint.length > 0 ? box.paint : [hostRoles.listMarker.group];
}

/** Paint marks of `groups` over one range. */
export function paintRange(run: Run, groups: readonly string[], depth: number, r: CellRange): void {
    groups.forEach((g: string, i: number): void => mark(run, r.line, r.startCol, r.endCol, g, paintPriority(MarkPriority.style, depth, i)));
}

/** Writes an outside marker in the buffer (or reserves it for overlay virtual text) on `line`. */
export function writeOutsideMarker(run: Run, m: PendingMarker, line: number, forceBuffer: boolean): void {
    const text: string = markerDisplay(m.box, run.opts);
    const w: number = displayWidth(text);
    const col: number = Math.max(0, m.col);
    if (run.opts.virtual && !forceBuffer) {
        ensureLine(run, line);
        m.placed.ranges = [{ line, startCol: col, endCol: col }];
    } else {
        put(run, line, col, text);
        m.placed.ranges = [{ line, startCol: col, endCol: col + w }];
        markerGroups(m.box).forEach((g: string, i: number): void => mark(run, line, col, col + w, g, paintPriority(MarkPriority.style, m.depth, i)));
    }
    m.placed.startLine = line;
    m.placed.endLine = line;
}

// ---------------------------------------------------------------- block formatting

/** Draws the borders of a box spanning `[top, bottom]` × `[x, x + w)`. */
function drawBorders(run: Run, style: ComputedStyle, top: number, bottom: number, x: number, w: number, depth: number): void {
    const b: ComputedStyle["border"] = style.border;
    const bl: number = b.left.width > 0 ? 1 : 0;
    const br: number = b.right.width > 0 ? 1 : 0;
    const prio: number = paintPriority(MarkPriority.style, depth, 3);
    const inner: number = Math.max(0, w - bl - br);
    const sideLine = (line: number, side: ComputedStyle["border"]["top"], corners: [string, string]): void => {
        const g: string[] = glyphs(side.style, run.opts.rule);
        const text: string = (bl > 0 ? corners[0] : "") + g[0].repeat(inner) + (br > 0 ? corners[1] : "");
        put(run, line, x, text);
        mark(run, line, x, x + displayWidth(text), borderGroup(side), prio);
    };
    if (b.top.width > 0) {
        const g: string[] = glyphs(b.top.style, run.opts.rule);
        sideLine(top, b.top, [g[2], g[3]]);
    }
    if (b.bottom.width > 0 && bottom >= top) {
        const g: string[] = glyphs(b.bottom.style, run.opts.rule);
        sideLine(bottom, b.bottom, [g[4], g[5]]);
    }
    for (let line = top + (b.top.width > 0 ? 1 : 0); line <= bottom - (b.bottom.width > 0 ? 1 : 0); line++) {
        if (bl > 0) {
            put(run, line, x, glyphs(b.left.style, run.opts.rule)[1]);
            mark(run, line, x, x + 1, borderGroup(b.left), prio);
        }
        // overflowing content (nowrap, code) wins over the right border: content is never overwritten
        if (br > 0 && lineWidth(run, line) < x + w) {
            put(run, line, x + w - 1, glyphs(b.right.style, run.opts.rule)[1]);
            mark(run, line, x + w - 1, x + w, borderGroup(b.right), prio);
        }
    }
}

/** Widest outside marker among the list-item children. */
function markerWidth(children: readonly Box[], opts: Opts): number {
    return children.reduce((acc: number, c: Box): number => {
        const m: MarkerBox | undefined = c.kind === "list-item" ? c.marker : undefined;
        return m !== undefined && m.position === "outside" ? Math.max(acc, displayWidth(markerDisplay(m, opts))) : acc;
    }, 0);
}

/** Places a block-level child at `[x, x + w)` (its margins applied here). */
export function placeChild(run: Run, child: Box, x: number, w: number, depth: number, siblingMarker: number): PlacedBox {
    const ml: number = Math.max(0, child.style.margin.left);
    const mr: number = Math.max(0, child.style.margin.right);
    const cx: number = x + ml;
    const cw: number = Math.max(1, w - ml - mr);
    let out: PlacedBox;
    if (child.kind === "block" || child.kind === "list-item") {
        out = placeBlock(run, child, cx, cw, depth, siblingMarker);
    } else if (child.kind === "table") {
        out = placeTable(run, child, cx, cw, depth);
    } else if (child.kind === "flex-row") {
        out = placeFlex(run, child, cx, cw, depth);
    } else if (child.kind === "table-row") {
        const table: TableBox = { kind: "table", style: anonStyle(child.style), paint: [], captions: [], rows: [child] };
        out = placeTable(run, table, cx, cw, depth);
    } else if (child.kind === "table-cell") {
        const row: TableRowBox = { kind: "table-row", style: anonStyle(child.style), paint: [], group: "body", cells: [child] };
        out = placeTable(run, { kind: "table", style: anonStyle(child.style), paint: [], captions: [], rows: [row] }, cx, cw, depth);
    } else {
        const p: PlacedBox[] = placeInline(run, [child], x, w, depth, child.style);
        out = p[0] ?? emptyPlaced(child, run, x, w);
    }
    return out;
}

/** Places the content of a block at `[cx, cx + cw)` in place of its children (a flex container's row). */
export type InnerPlacer = (run: Run, cx: number, cw: number, depth: number) => PlacedBox[];

/**
 * Block formatting of a block container or list item at `[x, x + w)` (margins already applied horizontally);
 * `inner`, when given, places the content instead of the block's children.
 */
export function placeBlock(run: Run, box: BlockBox | ListItemBox, x: number, w: number, depth: number, siblingMarker: number, inner?: InnerPlacer): PlacedBox {
    const s: ComputedStyle = box.style;
    const bt: number = s.border.top.width > 0 ? 1 : 0;
    const bb: number = s.border.bottom.width > 0 ? 1 : 0;
    const bl: number = s.border.left.width > 0 ? 1 : 0;
    const br: number = s.border.right.width > 0 ? 1 : 0;
    const pt: number = Math.max(0, s.padding.top);
    const pb: number = Math.max(0, s.padding.bottom);
    const kids: number = childDepth(box, depth);
    const logIdx: number = run.flushLog.length;
    let cx: number = x + bl + Math.max(0, s.padding.left);
    let cw: number = Math.max(1, w - bl - br - Math.max(0, s.padding.left) - Math.max(0, s.padding.right));
    run.pending = Math.max(run.pending, s.margin.top);
    if (bt + pt > 0) {
        flush(run);
        run.y += bt + pt;
    }
    let markerPlaced: PlacedBox | undefined;
    let pendingMarker: PendingMarker | undefined;
    if (box.kind === "list-item" && box.marker !== undefined) {
        const mw: number = displayWidth(markerDisplay(box.marker, run.opts));
        const hang: number = box.marker.position === "outside" ? Math.max(0, Math.max(siblingMarker, mw) - cx) : 0;
        cx += hang;
        cw = Math.max(1, cw - hang);
        markerPlaced = { box: box.marker, startLine: run.y, endLine: run.y, contentCol: cx - mw, width: mw, ranges: [], children: [] };
        pendingMarker = { box: box.marker, col: box.marker.position === "outside" ? cx - mw : cx, depth: kids, placed: markerPlaced };
        run.markers.push(pendingMarker);
    }
    let children: PlacedBox[];
    if (inner !== undefined) {
        children = inner(run, cx, cw, kids);
    } else if (box.children.some(blockLevel)) {
        const sm: number = markerWidth(box.children, run.opts);
        children = box.children.map((c: Box): PlacedBox => placeChild(run, c, cx, cw, kids, sm));
    } else {
        children = placeInline(run, box.children, cx, cw, kids, s);
    }
    if (pendingMarker !== undefined && run.markers.includes(pendingMarker)) {
        // no line box: the marker gets its own line (buffer text, nothing to overlay)
        const line: number = run.flushLog.length > logIdx ? (run.flushLog[logIdx] as number) : flush(run);
        if (run.y <= line) {
            run.y = line + 1;
        }
        run.markers = run.markers.filter((m: PendingMarker): boolean => m !== pendingMarker);
        writeOutsideMarker(run, pendingMarker, line, true);
    }
    if (bb + pb > 0) {
        if (run.flushLog.length === logIdx) {
            flush(run);
        } else {
            run.y += Math.max(0, run.pending);
        }
        run.pending = 0;
        run.y += pb + bb;
        run.pending = s.margin.bottom;
    } else {
        run.pending = Math.max(run.pending, s.margin.bottom);
    }
    const emitted: boolean = run.flushLog.length > logIdx;
    const startLine: number = emitted ? (run.flushLog[logIdx] as number) : run.y;
    const endLine: number = emitted ? run.y - 1 : run.y - 1;
    if (emitted) {
        finishBlock(run, box, startLine, endLine, x, w, cx, depth);
    }
    if (markerPlaced !== undefined) {
        children.unshift(markerPlaced);
    }
    return { box, startLine, endLine, contentCol: cx, width: w, ranges: [], children };
}

/** Code rectangle padding, paint marks over the box, borders. */
function finishBlock(run: Run, box: BlockBox | ListItemBox, top: number, bottom: number, x: number, w: number, cx: number, depth: number): void {
    const s: ComputedStyle = box.style;
    const bg: boolean = !("hex" in s.backgroundColor) || s.backgroundColor.alpha > 0;
    const code: boolean = s.custom["--htmlview-code"] === "block";
    ensureLine(run, bottom);
    if (code && bg) {
        const ct: number = top + (s.border.top.width > 0 ? 1 : 0) + Math.max(0, s.padding.top);
        const cb: number = bottom - (s.border.bottom.width > 0 ? 1 : 0) - Math.max(0, s.padding.bottom);
        const right: number = x + w - (s.border.right.width > 0 ? 1 : 0);
        for (let line = ct; line <= cb; line++) {
            if (lineWidth(run, line) < right) {
                put(run, line, right, "");
                run.keep.add(line);
            }
        }
    }
    if (box.paint.length > 0) {
        // A background fills the padding box: a solid border covers it in a browser, so border cells stay untinted.
        const first: number = bg ? top + (s.border.top.width > 0 ? 1 : 0) : top;
        const last: number = bg ? bottom - (s.border.bottom.width > 0 ? 1 : 0) : bottom;
        const left: number = x + (s.border.left.width > 0 ? 1 : 0);
        const right: number = x + w - (s.border.right.width > 0 ? 1 : 0);
        for (let line = first; line <= last; line++) {
            const end: number = bg ? Math.min(lineWidth(run, line), right) : lineWidth(run, line);
            paintRange(run, box.paint, depth, { line, startCol: bg ? left : Math.min(cx, x + w), endCol: end });
        }
    }
    drawBorders(run, s, top, bottom, x, w, childDepth(box, depth));
}

/** Entry point: places the root block. */
export function place(root: BlockBox, opts: LayoutOptions): PlacedTree {
    const run: Run = newRun(resolveOpts(opts));
    const placed: PlacedBox = placeBlock(run, root, 0, run.opts.width, 0, 0);
    const lines: string[] = trimLines(run);
    while (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
    }
    return { lines, marks: clipMarks(run.marks, lines), root: placed };
}
