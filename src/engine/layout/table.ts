/**
 * Tables: cells laid out as fragments, columns between min-content and max-content fitted to the width, a grid
 * drawn only when the computed border styles ask for one (glyphs per border style, the border colour's group),
 * a rule under header rows and between tall body rows. When even min-content columns do not fit, rows stack.
 */
import { displayWidth, MarkPriority } from "../../common";
import type { BorderSide, ComputedStyle } from "../style";
import type { Fragment, Run } from "./canvas";
import { blit, borderGroup, ensureLine, flush, fragmentWidth, glyphs, lineWidth, mark, put } from "./canvas";
import { paintPriority } from "./index";
import type { BlockBox, Box, PlacedBox, TableBox, TableCellBox, TableRowBox } from "./index";
import { fragment } from "./flex";
import { emptyPlaced, placeChild } from "./place";

interface GridCell {
    cell: TableCellBox;
    col: number;
    span: number;
}

interface GridRow {
    row: TableRowBox;
    cells: GridCell[];
    header: boolean;
}

const NO_EDGES: ComputedStyle["margin"] = { top: 0, right: 0, bottom: 0, left: 0 };

function buildGrid(table: TableBox): { rows: GridRow[]; ncols: number } {
    let ncols: number = 0;
    const rows: GridRow[] = table.rows
        .filter((row: TableRowBox): boolean => row.cells.length > 0)
        .map((row: TableRowBox): GridRow => {
            let col: number = 0;
            const cells: GridCell[] = row.cells.map((cell: TableCellBox): GridCell => {
                const placed: GridCell = { cell, col, span: Math.max(1, cell.colspan) };
                col += placed.span;
                return placed;
            });
            ncols = Math.max(ncols, col);
            return { row, cells, header: row.group === "header" };
        });
    return { rows, ncols: Math.max(1, ncols) };
}

/** The cell as a block (borders are the grid's, margins do not apply to cells). */
function cellBlock(cell: TableCellBox): BlockBox {
    const none: BorderSide = { style: "none", width: 0, color: cell.style.color };
    const style: ComputedStyle = { ...cell.style, display: "block", margin: NO_EDGES, border: { top: none, right: none, bottom: none, left: none } };
    return { kind: "block", element: cell.element, style, paint: cell.paint, children: cell.children };
}

function cellFragment(run: Run, cell: TableCellBox, width: number, depth: number, split: boolean): Fragment {
    return fragment({ ...run.opts, split }, [cellBlock(cell)], Math.max(1, width), depth);
}

function distribute(mins: number[], maxs: number[], avail: number): number[] {
    const widths: number[] = mins.slice();
    let left: number = avail - mins.reduce((a: number, b: number): number => a + b, 0);
    const slack: number[] = maxs.map((m: number, i: number): number => m - mins[i]);
    const total: number = slack.reduce((a: number, b: number): number => a + b, 0);
    if (total > 0) {
        const shares: number[] = slack.map((s: number): number => Math.floor((s * left) / total));
        shares.forEach((s: number, i: number): void => {
            widths[i] += s;
        });
        left -= shares.reduce((a: number, b: number): number => a + b, 0);
        widths.forEach((w: number, i: number): void => {
            if (left > 0 && w < maxs[i]) {
                widths[i] += 1;
                left -= 1;
            }
        });
    }
    return widths;
}

function spanWidth(widths: readonly number[], c: GridCell): number {
    return widths.slice(c.col, c.col + c.span).reduce((a: number, b: number): number => a + b, 0) + (c.span - 1);
}

/** Column widths (cell padding included) that fit `avail`, or undefined. */
function fitColumns(run: Run, grid: { rows: GridRow[]; ncols: number }, avail: number, depth: number): number[] | undefined {
    const mins: number[] = new Array<number>(grid.ncols).fill(1);
    const maxs: number[] = new Array<number>(grid.ncols).fill(1);
    const measured: Array<{ c: GridCell; min: number; max: number }> = [];
    grid.rows.forEach((r: GridRow): void => {
        r.cells.forEach((c: GridCell): void => {
            const pr: number = Math.max(0, c.cell.style.padding.right);
            const min: number = fragmentWidth(cellFragment(run, c.cell, 1, depth, false)) + pr;
            const max: number = Math.max(min, fragmentWidth(cellFragment(run, c.cell, Math.max(1, avail), depth, true)) + pr);
            measured.push({ c, min, max });
            if (c.span === 1) {
                mins[c.col] = Math.max(mins[c.col], min);
                maxs[c.col] = Math.max(maxs[c.col], max);
            }
        });
    });
    const sumMin: number = mins.reduce((a: number, b: number): number => a + b, 0);
    const sumMax: number = maxs.reduce((a: number, b: number): number => a + b, 0);
    let widths: number[] | undefined;
    if (sumMax <= avail) {
        widths = maxs;
    } else if (sumMin <= avail) {
        widths = distribute(mins, maxs, avail);
    }
    if (widths !== undefined) {
        const fixed: number[] = widths;
        measured
            .filter((m: { c: GridCell }): boolean => m.c.span > 1)
            .forEach((m: { c: GridCell; min: number; max: number }): void => {
                const missing: number = Math.min(m.max, avail) - spanWidth(fixed, m.c);
                if (missing > 0) {
                    fixed[Math.min(grid.ncols, m.c.col + m.c.span) - 1] += missing;
                }
            });
        widths = fixed.reduce((a: number, b: number): number => a + b, 0) <= avail ? fixed : undefined;
    }
    return widths;
}

/** Column indexes (1..ncols-1) where a cell of `row` starts. */
function edges(row: GridRow | undefined, ncols: number): Set<number> {
    const out: Set<number> = new Set();
    if (row !== undefined) {
        for (let c = 1; c < ncols; c++) {
            if (!row.cells.some((p: GridCell): boolean => p.col < c && c < p.col + p.span)) {
                out.add(c);
            }
        }
    }
    return out;
}

function borderLine(widths: readonly number[], above: GridRow | undefined, below: GridRow | undefined, g: readonly string[]): string {
    const up: Set<number> = edges(above, widths.length);
    const down: Set<number> = edges(below, widths.length);
    const left: string = above === undefined ? g[2] : below === undefined ? g[4] : g[6];
    const right: string = above === undefined ? g[3] : below === undefined ? g[5] : g[7];
    let line: string = left;
    widths.forEach((w: number, c: number): void => {
        if (c > 0) {
            const u: boolean = up.has(c);
            const d: boolean = down.has(c);
            line += u && d ? g[10] : u ? g[9] : d ? g[8] : g[0];
        }
        line += g[0].repeat(w);
    });
    return line + right;
}

/** The side whose style draws the grid: the table's, else the first bordered cell's; undefined = no grid. */
function gridSide(table: TableBox): BorderSide | undefined {
    const sides: BorderSide[] = [table.style.border.top, table.style.border.left];
    table.rows.forEach((r: TableRowBox): void => {
        r.cells.forEach((c: TableCellBox): void => {
            sides.push(c.style.border.left, c.style.border.top, c.style.border.right, c.style.border.bottom);
        });
    });
    return sides.find((s: BorderSide): boolean => s.style !== "none" && s.width > 0);
}

function rule(run: Run, line: number, x: number, text: string, group: string, depth: number): void {
    put(run, line, x, text);
    mark(run, line, x, x + displayWidth(text), group, paintPriority(MarkPriority.style, depth, 3));
}

function paintLines(run: Run, groups: readonly string[], top: number, bottom: number, x: number, w: number, depth: number): void {
    for (let line = top; line <= bottom; line++) {
        groups.forEach((g: string, i: number): void => mark(run, line, x, Math.min(lineWidth(run, line), x + w), g, paintPriority(MarkPriority.style, depth, i)));
    }
}

/** The cell's placed box (the fragment's block, re-labelled with the cell box). */
function cellPlaced(frag: Fragment, cell: TableCellBox, run: Run, x: number, w: number): PlacedBox {
    const p: PlacedBox | undefined = frag.placed[0];
    return p !== undefined ? { ...p, box: cell } : emptyPlaced(cell, run, x, w);
}

function placeGrid(run: Run, table: TableBox, grid: { rows: GridRow[]; ncols: number }, widths: number[], x: number, depth: number, side: BorderSide | undefined): PlacedBox[] {
    const outer: number = side !== undefined ? 1 : 0;
    const g: string[] = glyphs(side !== undefined ? side.style : "solid", run.opts.rule);
    const group: string = side !== undefined ? borderGroup(side) : "";
    const total: number = widths.reduce((a: number, b: number): number => a + b, 0) + (widths.length - 1) + 2 * outer;
    const colX = (c: number): number => x + outer + widths.slice(0, c).reduce((a: number, b: number): number => a + b, 0) + c;
    const frags: Fragment[][] = grid.rows.map((r: GridRow): Fragment[] => r.cells.map((c: GridCell): Fragment => cellFragment(run, c.cell, spanWidth(widths, c), depth, true)));
    const heights: number[] = frags.map((fs: Fragment[]): number => fs.reduce((acc: number, f: Fragment): number => Math.max(acc, f.lines.length), 1));
    const tall: boolean = grid.rows.some((r: GridRow, i: number): boolean => !r.header && heights[i] > 1);
    let y: number = flush(run);
    if (outer > 0) {
        rule(run, y, x, borderLine(widths, undefined, grid.rows[0], g), group, depth);
        y += 1;
    }
    const placedRows: PlacedBox[] = [];
    grid.rows.forEach((r: GridRow, i: number): void => {
        const prev: GridRow | undefined = i > 0 ? grid.rows[i - 1] : undefined;
        if (outer > 0 && prev !== undefined && (prev.header !== r.header || (tall && !r.header))) {
            rule(run, y, x, borderLine(widths, prev, r, g), group, depth);
            y += 1;
        }
        const cells: PlacedBox[] = r.cells.map((c: GridCell, k: number): PlacedBox => {
            const frag: Fragment = frags[i][k];
            blit(run, frag, y, colX(c.col));
            return cellPlaced(frag, c.cell, run, colX(c.col), spanWidth(widths, c));
        });
        for (let line = y; line < y + heights[i]; line++) {
            ensureLine(run, line);
            if (outer > 0) {
                rule(run, line, x, g[1], group, depth);
                rule(run, line, x + total - 1, g[1], group, depth);
                r.cells.filter((c: GridCell): boolean => c.col > 0).forEach((c: GridCell): void => rule(run, line, colX(c.col) - 1, g[1], group, depth));
            }
        }
        paintLines(run, r.row.paint, y, y + heights[i] - 1, x, total, depth + 1);
        placedRows.push({ box: r.row, startLine: y, endLine: y + heights[i] - 1, contentCol: x + outer, width: total, ranges: [], children: cells });
        y += heights[i];
    });
    if (outer > 0) {
        rule(run, y, x, borderLine(widths, grid.rows[grid.rows.length - 1], undefined, g), group, depth);
        y += 1;
    }
    run.y = y;
    return placedRows;
}

/** Stacked fallback: each body row as its cells, each under its column's header cell, rows ruled apart. */
function placeStacked(run: Run, grid: { rows: GridRow[]; ncols: number }, x: number, w: number, depth: number, group: string): PlacedBox[] {
    const headerRow: GridRow | undefined = grid.rows.find((r: GridRow): boolean => r.header);
    const body: GridRow[] = grid.rows.filter((r: GridRow): boolean => !r.header);
    const shown: GridRow[] = body.length > 0 ? body : grid.rows;
    let y: number = flush(run);
    const out: PlacedBox[] = [];
    shown.forEach((r: GridRow, i: number): void => {
        const top: number = y;
        if (i > 0) {
            rule(run, y, x, run.opts.rule.repeat(Math.max(1, w)), group, depth);
            y += 1;
        }
        const cells: PlacedBox[] = r.cells.map((c: GridCell): PlacedBox => {
            const label: GridCell | undefined = headerRow !== undefined && body.length > 0 && c.span === 1 ? headerRow.cells.find((h: GridCell): boolean => h.col === c.col) : undefined;
            if (label !== undefined) {
                const lf: Fragment = cellFragment(run, label.cell, w, depth, true);
                blit(run, lf, y, x);
                y += lf.lines.length;
            }
            const indent: number = label !== undefined ? 2 : 0;
            const f: Fragment = cellFragment(run, c.cell, w - indent, depth, true);
            blit(run, f, y, x + indent);
            y += f.lines.length;
            return cellPlaced(f, c.cell, run, x + indent, w - indent);
        });
        out.push({ box: r.row, startLine: top, endLine: y - 1, contentCol: x, width: w, ranges: [], children: cells });
    });
    run.y = y;
    return out;
}

/** Places a table box at `[x, x + w)` (margins already applied horizontally). */
export function placeTable(run: Run, table: TableBox, x: number, w: number, depth: number): PlacedBox {
    const kids: number = table.element !== undefined ? depth + 1 : depth;
    run.pending = Math.max(run.pending, table.style.margin.top);
    const logIdx: number = run.flushLog.length;
    const captions: PlacedBox[] = table.captions.map((c: BlockBox): PlacedBox => placeChild(run, c, x, w, kids, 0));
    const grid: { rows: GridRow[]; ncols: number } = buildGrid(table);
    const side: BorderSide | undefined = gridSide(table);
    const outer: number = side !== undefined ? 1 : 0;
    const avail: number = w - 2 * outer - (grid.ncols - 1);
    let rows: PlacedBox[] = [];
    let total: number = w;
    if (grid.rows.length > 0) {
        const widths: number[] | undefined = avail > 0 ? fitColumns(run, grid, avail, kids) : undefined;
        if (widths !== undefined) {
            total = widths.reduce((a: number, b: number): number => a + b, 0) + (grid.ncols - 1) + 2 * outer;
            rows = placeGrid(run, table, grid, widths, x, kids, side);
        } else {
            rows = placeStacked(run, grid, x, w, kids, side !== undefined ? borderGroup(side) : "");
        }
    }
    const emitted: boolean = run.flushLog.length > logIdx;
    const startLine: number = emitted ? (run.flushLog[logIdx] as number) : run.y;
    if (emitted) {
        paintLines(run, table.paint, startLine, run.y - 1, x, total, depth);
    }
    run.pending = table.style.margin.bottom;
    const children: PlacedBox[] = captions.concat(rows);
    return { box: table as Box, startLine, endLine: run.y - 1, contentCol: x + outer, width: total, ranges: [], children };
}
