/**
 * The placement state of one layout run: the buffer canvas (lines and marks written at absolute cells), the
 * vertical cursor with its pending collapsed margin, pending list markers, and helpers to write text by cells and
 * to move a laid-out fragment (lines, marks, placed boxes) to another position.
 */
import { codePointWidth, displayWidth } from "../../common";
import type { Mark } from "../../types";
import type { BorderSide, Color } from "../style";
import { borderColorGroup, groupName } from "../style";
import { hostRoles } from "../style/host";
import type { CellRange, MarkerBox, PlacedBox } from "./index";

/** Resolved layout options. */
export interface Opts {
    width: number;
    tabstop: number;
    virtual: boolean;
    showTarget: boolean;
    symbol: string;
    rule: string;
    bullets?: string[];
    image: string;
    /** Split overlong words (off when measuring min-content). */
    split: boolean;
}

/** A list marker waiting for the first line of its item. */
export interface PendingMarker {
    box: MarkerBox;
    /** Cell where an outside marker starts. */
    col: number;
    depth: number;
    placed: PlacedBox;
}

/** Mutable state of one placement run (local to a call, never module-level). */
export interface Run {
    opts: Opts;
    lines: string[];
    marks: Mark[];
    /** Next free line. */
    y: number;
    /** Collapsed vertical margin waiting to become blank lines. */
    pending: number;
    /** Whether a line was emitted (leading margins of the run are dropped). */
    started: boolean;
    /** Line of every flush, in order (a box's first line is the first flush after it started). */
    flushLog: number[];
    markers: PendingMarker[];
    /** Lines whose trailing spaces are kept (padded code rectangles). */
    keep: Set<number>;
}

/** A new run with `opts`. */
export function newRun(opts: Opts): Run {
    return { opts, lines: [], marks: [], y: 0, pending: 0, started: false, flushLog: [], markers: [], keep: new Set() };
}

/** Turns the pending margin into blank lines (none at the start of a run); returns the line content starts at. */
export function flush(run: Run): number {
    if (run.started) {
        run.y += Math.max(0, run.pending);
    }
    run.pending = 0;
    run.started = true;
    run.flushLog.push(run.y);
    return run.y;
}

/** Splits `line` at cell `col`: the left part padded to exactly `col` cells, and the rest after `col + skip` cells. */
function splitCells(line: string, col: number, skip: number): [string, string] {
    let left: string = "";
    let right: string = "";
    let cell: number = 0;
    for (const ch of line) {
        const w: number = codePointWidth(ch.codePointAt(0) as number);
        if (cell + w <= col) {
            left += ch;
        } else if (cell >= col + skip) {
            right += ch;
        } else if (cell < col) {
            left += " ".repeat(col - cell);
        } else if (cell + w > col + skip) {
            right += " ".repeat(cell + w - (col + skip));
        }
        cell += w;
    }
    return [left + " ".repeat(Math.max(0, col - displayWidth(left))), right];
}

/** Writes `text` at (`line`, `col`), padding with spaces and overwriting the cells it covers. */
export function put(run: Run, line: number, col: number, text: string): void {
    while (run.lines.length <= line) {
        run.lines.push("");
    }
    const current: string = run.lines[line];
    const cw: number = displayWidth(current);
    if (cw <= col) {
        run.lines[line] = current + " ".repeat(col - cw) + text;
    } else {
        const [left, right] = splitCells(current, col, displayWidth(text));
        run.lines[line] = left + text + right;
    }
}

/** Makes sure lines up to `line` exist. */
export function ensureLine(run: Run, line: number): void {
    while (run.lines.length <= line) {
        run.lines.push("");
    }
}

/** Cell width of line `line` (0 when absent). */
export function lineWidth(run: Run, line: number): number {
    return line < run.lines.length ? displayWidth(run.lines[line]) : 0;
}

/** Adds a mark when the range is not empty. */
export function mark(run: Run, line: number, startCol: number, endCol: number, group: string, priority: number): void {
    if (endCol > startCol && startCol >= 0 && group !== "") {
        run.marks.push({ line, startCol, endCol, group, priority });
    }
}

/** A border colour's group (var → variable group, group → itself, literal → its own group, transparent → `fallback`). */
function colorGroup(color: Color, fallback: string): string {
    let out: string;
    const literal: string | undefined = borderColorGroup(color);
    if (literal !== undefined) {
        out = literal;
    } else if ("var" in color) {
        out = groupName(color.var);
    } else if ("group" in color && color.group !== hostRoles.canvas.group) {
        out = color.group;
    } else {
        out = fallback;
    }
    return out;
}

/** The border group of a side. */
export function borderGroup(side: BorderSide): string {
    return colorGroup(side.color, hostRoles.border.group);
}

/** Box-drawing glyphs per border style: horizontal, vertical, ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼. */
export function glyphs(style: string, rule: string): string[] {
    let out: string[];
    if (style === "double") {
        out = ["═", "║", "╔", "╗", "╚", "╝", "╠", "╣", "╦", "╩", "╬"];
    } else if (style === "dashed") {
        out = ["╌", "╎", "┌", "┐", "└", "┘", "├", "┤", "┬", "┴", "┼"];
    } else if (style === "dotted") {
        out = ["┈", "┊", "┌", "┐", "└", "┘", "├", "┤", "┬", "┴", "┼"];
    } else {
        out = [rule, "│", "┌", "┐", "└", "┘", "├", "┤", "┬", "┴", "┼"];
    }
    return out;
}

/** Moves a placed box tree by `dl` lines and `dc` cells (in place). */
export function shiftPlaced(p: PlacedBox, dl: number, dc: number): void {
    p.startLine += dl;
    p.endLine += dl;
    p.contentCol += dc;
    p.ranges = p.ranges.map((r: CellRange): CellRange => ({ line: r.line + dl, startCol: r.startCol + dc, endCol: r.endCol + dc }));
    p.children.forEach((c: PlacedBox): void => shiftPlaced(c, dl, dc));
}

/** A laid-out fragment (lines from col 0, marks and placed boxes relative to it). */
export interface Fragment {
    lines: string[];
    marks: Mark[];
    placed: PlacedBox[];
    keep: Set<number>;
}

/** Widest line of a fragment in cells. */
export function fragmentWidth(frag: Fragment): number {
    return frag.lines.reduce((acc: number, l: string): number => Math.max(acc, displayWidth(l)), 0);
}

/** Copies a fragment into the run at (`line`, `col`). */
export function blit(run: Run, frag: Fragment, line: number, col: number): void {
    frag.lines.forEach((text: string, k: number): void => {
        ensureLine(run, line + k);
        if (text !== "") {
            put(run, line + k, col, text);
        }
    });
    frag.marks.forEach((m: Mark): void => {
        run.marks.push({ ...m, line: m.line + line, startCol: m.startCol + col, endCol: m.endCol + col });
    });
    frag.placed.forEach((p: PlacedBox): void => shiftPlaced(p, line, col));
    frag.keep.forEach((k: number): void => {
        run.keep.add(k + line);
    });
}

/** Removes trailing spaces of every line not kept; returns the lines. */
export function trimLines(run: Run): string[] {
    return run.lines.map((l: string, i: number): string => (run.keep.has(i) ? l : l.replace(/ +$/, "")));
}

/** Clips marks to their (trimmed) lines, dropping empty ones. */
export function clipMarks(marks: readonly Mark[], lines: readonly string[]): Mark[] {
    const widths: number[] = lines.map((l: string): number => displayWidth(l));
    const out: Mark[] = [];
    for (const m of marks) {
        const end: number = Math.min(m.endCol, m.line < widths.length ? widths[m.line] : 0);
        if (m.lineHl === true || end > m.startCol) {
            out.push(m.lineHl === true ? m : { ...m, endCol: end });
        }
    }
    return out;
}
