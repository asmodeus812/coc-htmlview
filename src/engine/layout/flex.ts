/** Fragments and flex: boxes laid out apart (for tables, flex items and atomic inlines), max-content widths, flex rows. */
import { displayWidth } from "../../common";
import type { ComputedStyle } from "../style";
import { anonStyle } from "./build";
import type { Fragment, Opts, Run } from "./canvas";
import { blit, clipMarks, ensureLine, flush, fragmentWidth, newRun, trimLines } from "./canvas";
import type { BlockBox, Box, FlexRowBox, PlacedBox } from "./index";
import { blockLevel, markerDisplay, placeBlock } from "./place";
import type { InnerPlacer } from "./place";

/** Lays `boxes` out apart (block children of an anonymous block at `[0, width)`). */
export function fragment(opts: Opts, boxes: readonly Box[], width: number, depth: number): Fragment {
    const run: Run = newRun(opts);
    const style: ComputedStyle = boxes.length > 0 ? anonStyle(boxes[0].style) : anonStyle(defaultStyleOf());
    const holder: BlockBox = { kind: "block", style, paint: [], children: boxes.slice(), anonymous: true };
    const placed: PlacedBox = placeBlock(run, holder, 0, Math.max(1, width), depth, 0);
    const lines: string[] = trimLines(run);
    return { lines, marks: clipMarks(run.marks, lines), placed: placed.children, keep: run.keep };
}

function defaultStyleOf(): ComputedStyle {
    const none: ComputedStyle["border"]["top"] = { style: "none", width: 0, color: { hex: "#000000", alpha: 0 } };
    const zero: ComputedStyle["margin"] = { top: 0, right: 0, bottom: 0, left: 0 };
    return {
        display: "block", visibility: "visible", margin: zero, padding: zero, border: { top: none, right: none, bottom: none, left: none },
        color: { hex: "#000000", alpha: 0 }, backgroundColor: { hex: "#000000", alpha: 0 }, fontWeight: 400, fontStyle: "normal",
        textDecoration: { underline: false, lineThrough: false, overline: false }, whiteSpace: "normal", tabSize: 0, textAlign: "left", textTransform: "none",
        listStyleType: "none", listStylePosition: "outside", order: 0, alignItems: "normal", fill: false, counterReset: [], counterIncrement: [], counterSet: [], custom: {},
    };
}

/** A width no max-content measurement reaches: layout at it never wraps a line. */
const UNBOUNDED: number = 4096;
const NO_EDGES: ComputedStyle["margin"] = { top: 0, right: 0, bottom: 0, left: 0 };

/** Cells taken by a box's own horizontal padding and borders. */
function edgeCells(s: ComputedStyle): number {
    return (s.border.left.width > 0 ? 1 : 0) + (s.border.right.width > 0 ? 1 : 0) + Math.max(0, s.padding.left) + Math.max(0, s.padding.right);
}

/** The longest unbroken line of an inline run (laid out unbounded, left-aligned). */
function inlineMaxContent(opts: Opts, boxes: readonly Box[], style: ComputedStyle, depth: number): number {
    const holder: BlockBox = { kind: "block", style: { ...anonStyle(style), textAlign: "left" }, paint: [], children: boxes.slice(), anonymous: true };
    return fragmentWidth(fragment(opts, [holder], UNBOUNDED, depth));
}

/** The free cells between two adjacent flex items: 1 unless their margins already separate them. */
function flexGap(prev: Box, next: Box): number {
    return Math.max(0, prev.style.margin.right) + Math.max(0, next.style.margin.left) > 0 ? 0 : 1;
}

/**
 * CSS max-content width of `box` in cells, its own padding, borders and horizontal margins included: a block takes
 * its widest child (plus a list marker), inline content its longest unbroken line, a flex row the sum of its items
 * and the gaps. Other block-level boxes (tables) are laid out unbounded and measured.
 */
export function maxContent(opts: Opts, box: Box, depth: number): number {
    const s: ComputedStyle = box.style;
    const margins: number = Math.max(0, s.margin.left) + Math.max(0, s.margin.right);
    let content: number;
    if (box.kind === "block" || box.kind === "list-item") {
        const marker: number = box.kind === "list-item" && box.marker !== undefined ? displayWidth(markerDisplay(box.marker, opts)) : 0;
        const inner: number = box.children.some(blockLevel)
            ? box.children.reduce((acc: number, c: Box): number => Math.max(acc, maxContent(opts, c, depth)), 0)
            : inlineMaxContent(opts, box.children, s, depth);
        content = edgeCells(s) + marker + inner;
    } else if (box.kind === "flex-row") {
        content = edgeCells(s) + box.items.reduce((acc: number, it: Box, i: number): number => acc + maxContent(opts, it, depth) + (i > 0 ? flexGap(box.items[i - 1], it) : 0), 0);
    } else if (blockLevel(box)) {
        content = fragmentWidth(fragment(opts, [{ ...box, style: { ...s, margin: NO_EDGES } } as Box], UNBOUNDED, depth));
    } else {
        content = inlineMaxContent(opts, [box], s, depth) - Math.max(0, s.margin.left);
    }
    return content + margins;
}

/** The height of a flex item in its row: its lines plus its vertical margins. */
function outerHeight(it: Box, f: Fragment): number {
    return Math.max(0, it.style.margin.top) + f.lines.length + Math.max(0, it.style.margin.bottom);
}

/**
 * The row of a flex container (`flex-direction: row`) inside its content box `[cx, cx + cw)`: every item at its
 * shrink-to-fit width (max-content capped at `cw`), side by side with {@link flexGap} between them, wrapping onto a
 * new row when the next item does not fit. Wrapping happens with `flex-wrap: nowrap` too (style does not compute
 * flex-wrap, and a cell grid cannot shrink text or show an overflow). Items go in `order` (ties: document order), and
 * one with `width: 100%` takes a row of its own. Item margins do not collapse: a row is as
 * tall as its tallest item plus that item's vertical margins. `align-items` places a shorter item in a row at the top
 * (`normal`, `stretch`, `start`: text cannot stretch in a cell grid), the middle (`center`, rounding down) or the bottom (`end`).
 */
function flexRow(box: FlexRowBox): InnerPlacer {
    return (run: Run, cx: number, cw: number, kids: number): PlacedBox[] => {
        const items: Box[] = box.items.map((it: Box, i: number): [Box, number] => [it, i]).sort((a: [Box, number], b: [Box, number]): number => a[0].style.order - b[0].style.order || a[1] - b[1]).map((p: [Box, number]): Box => p[0]);
        const fits: number[] = items.map((it: Box): number => (it.style.fill ? cw : Math.max(1, Math.min(cw, maxContent(run.opts, it, kids)))));
        const frags: Fragment[] = items.map((it: Box, i: number): Fragment => fragment(run.opts, [it], fits[i], kids));
        let placed: PlacedBox[] = [];
        if (frags.some((f: Fragment): boolean => f.lines.length > 0)) {
            // pass 1: the rows (greedy wrap) and their heights; pass 2: blit each item, offset by `align-items`
            const rows: Array<{ at: number[]; cols: number[]; height: number }> = [];
            let col: number = cx;
            let prev: Box | undefined;
            frags.forEach((f: Fragment, i: number): void => {
                const it: Box = items[i];
                if (f.lines.length > 0) {
                    const gap: number = prev !== undefined ? flexGap(prev, it) : 0;
                    if (rows.length === 0 || (col > cx && col + gap + fits[i] > cx + cw)) {
                        rows.push({ at: [], cols: [], height: 0 });
                        col = cx;
                    } else {
                        col += gap;
                    }
                    const row = rows[rows.length - 1];
                    row.at.push(i);
                    row.cols.push(col);
                    col += fits[i];
                    row.height = Math.max(row.height, outerHeight(it, f));
                    prev = it;
                }
            });
            let line: number = flush(run);
            const align: ComputedStyle["alignItems"] = box.style.alignItems;
            rows.forEach((row): void => {
                row.at.forEach((i: number, k: number): void => {
                    const it: Box = items[i];
                    const free: number = row.height - outerHeight(it, frags[i]);
                    const shift: number = align === "center" ? Math.floor(free / 2) : align === "end" ? free : 0;
                    blit(run, frags[i], line + Math.max(0, it.style.margin.top) + shift, row.cols[k]);
                    placed = placed.concat(frags[i].placed);
                });
                line += row.height;
            });
            ensureLine(run, line - 1);
            run.y = line;
        }
        return placed;
    };
}

/**
 * A flex container: a block (margins, padding, borders and paint as any block) whose content is a {@link flexRow}.
 * Its own width is the available width, as `display: flex`; `inline-flex` computes to the same display, so an
 * inline-flex container shrinks only when it is itself a flex item or an atomic inline.
 */
export function placeFlex(run: Run, box: FlexRowBox, x: number, w: number, depth: number): PlacedBox {
    const holder: BlockBox = { kind: "block", element: box.element, style: box.style, paint: box.paint, children: box.items };
    return { ...placeBlock(run, holder, x, w, depth, 0, flexRow(box)), box };
}
