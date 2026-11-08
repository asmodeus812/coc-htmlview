/**
 * Inline flow: a run of items with per-item buffer width, screen width
 * (inline virtual text takes screen cells but no buffer cells), white-space flags and break opportunities,
 * wrapped greedily by screen cells. Break opportunities: breakable spaces, around wide (CJK/emoji) characters,
 * explicit opportunities (`--htmlview-break: opportunity`); a word longer than the width is split by cells only
 * when nothing else fits.
 */
import { codePointWidth } from "../../common";
import type { WhiteSpace } from "../style";

const NEWLINE: string = "\n";

/** One flow item: a buffer character (or `""` for virtual space / opportunities). */
export interface FlowItem {
    ch: string;
    /** Buffer cells. */
    w: number;
    /** Screen cells (≥ w: virtual text attached here counts). */
    sw: number;
    /** No break before this item (nowrap / pre / glued virtual text). */
    locked: boolean;
    /** A break opportunity after this item. */
    brk: boolean;
}

/** Accumulates the items of one inline formatting context. */
export class Flow {
    readonly items: FlowItem[] = [];

    /** Current length (the offset the next item gets). */
    get pos(): number {
        return this.items.length;
    }

    /** Appends `text` per `ws` (collapsing, newlines, tabs expanded with `tabstop`). */
    text(text: string, ws: WhiteSpace, tabstop: number): void {
        const keepSpaces: boolean = ws === "pre" || ws === "pre-wrap";
        const keepNewlines: boolean = keepSpaces || ws === "pre-line";
        const locked: boolean = ws === "pre" || ws === "nowrap";
        for (const ch of text) {
            if (ch === "\r") {
                // dropped: \r\n counts as one break
            } else if (keepNewlines && ch === "\n") {
                this.trimCollapsible(!keepSpaces);
                this.hardBreak();
            } else if (keepSpaces && ch === "\t") {
                const stop: number = Math.max(1, tabstop);
                const n: number = stop - (this.lineCells() % stop);
                for (let i = 0; i < n; i++) {
                    this.push(" ", 1, 1, locked);
                }
            } else if (!keepSpaces && (ch === " " || ch === "\t" || ch === "\n" || ch === "\f")) {
                if (!this.atLineStart() && this.lastChar() !== " ") {
                    this.push(" ", 1, 1, locked);
                }
            } else {
                const w: number = codePointWidth(ch.codePointAt(0) as number);
                this.push(ch, w, w, locked);
            }
        }
    }

    /** Appends unbreakable text kept as written (replaced text, atomic lines, markers, inline padding). */
    atomic(text: string): void {
        for (const ch of text) {
            const w: number = codePointWidth(ch.codePointAt(0) as number);
            this.push(ch, w, w, true);
        }
    }

    /** Virtual text of `cells` screen cells glued to the preceding item (no buffer text). */
    virtual(cells: number): void {
        this.items.push({ ch: "", w: 0, sw: cells, locked: true, brk: false });
    }

    /** A break opportunity without text. */
    opportunity(): void {
        this.items.push({ ch: "", w: 0, sw: 0, locked: false, brk: true });
    }

    /** A forced line break. */
    hardBreak(): void {
        this.items.push({ ch: NEWLINE, w: 0, sw: 0, locked: true, brk: false });
    }

    /** A line break only when not at the start of a line. */
    softBreak(): void {
        if (!this.atLineStart()) {
            this.hardBreak();
        }
    }

    /** True when the flow holds nothing visible (only spaces, breaks and opportunities). */
    isBlank(): boolean {
        return this.items.every((it: FlowItem): boolean => it.ch === " " || it.ch === NEWLINE || (it.ch === "" && it.sw === 0));
    }

    private push(ch: string, w: number, sw: number, locked: boolean): void {
        this.items.push({ ch, w, sw, locked, brk: false });
    }

    private lastChar(): string {
        let i: number = this.items.length - 1;
        while (i >= 0 && this.items[i].ch === "") {
            i--;
        }
        return i >= 0 ? this.items[i].ch : NEWLINE;
    }

    private atLineStart(): boolean {
        return this.lastChar() === NEWLINE;
    }

    /** Drops a collapsible trailing space before a preserved newline (pre-line). */
    private trimCollapsible(enabled: boolean): void {
        const last: FlowItem | undefined = this.items[this.items.length - 1];
        if (enabled && last !== undefined && last.ch === " ") {
            this.items.pop();
        }
    }

    private lineCells(): number {
        let cells: number = 0;
        let i: number = this.items.length - 1;
        while (i >= 0 && this.items[i].ch !== NEWLINE) {
            cells += this.items[i].w;
            i--;
        }
        return cells;
    }
}

/** One output line: the item range `[start, end)` it shows. */
export interface FlowLine {
    start: number;
    end: number;
}

function hardLines(items: readonly FlowItem[]): FlowLine[] {
    const out: FlowLine[] = [];
    let start: number = 0;
    items.forEach((it: FlowItem, i: number): void => {
        if (it.ch === NEWLINE) {
            out.push({ start, end: i });
            start = i + 1;
        }
    });
    if (start < items.length) {
        out.push({ start, end: items.length });
    }
    return out;
}

function trimLine(items: readonly FlowItem[], r: FlowLine): FlowLine {
    let end: number = r.end;
    while (end > r.start && items[end - 1].ch === " " && !items[end - 1].locked) {
        end--;
    }
    return { start: r.start, end };
}

/** Greedy wrap of one hard line by screen cells. */
function wrapRange(items: readonly FlowItem[], r: FlowLine, width: number, split: boolean): FlowLine[] {
    const out: FlowLine[] = [];
    let i: number = r.start;
    let first: boolean = true;
    while (first || i < r.end) {
        first = false;
        const lineStart: number = i;
        let w: number = 0;
        let lastEnd: number = -1;
        let lastResume: number = -1;
        let lineEnd: number = -1;
        let resume: number = -1;
        let j: number = i;
        while (lineEnd < 0 && j < r.end) {
            const it: FlowItem = items[j];
            const breakable: boolean = !it.locked;
            const space: boolean = it.ch === " " && breakable;
            const over: boolean = w + it.sw > width && j > lineStart;
            if (breakable && it.w === 2 && j > lineStart) {
                lastEnd = j;
                lastResume = j;
            }
            if (over && space) {
                lineEnd = j;
                resume = j + 1;
            } else if (over && lastEnd > lineStart) {
                lineEnd = lastEnd;
                resume = lastResume;
            } else if (over && breakable && split) {
                lineEnd = j;
                resume = j;
            } else {
                if (space && j > lineStart) {
                    lastEnd = j;
                    lastResume = j + 1;
                }
                w += it.sw;
                j++;
                if ((breakable && it.w === 2) || it.brk) {
                    lastEnd = j;
                    lastResume = j;
                }
            }
        }
        if (lineEnd < 0) {
            lineEnd = r.end;
            resume = r.end;
        }
        out.push(trimLine(items, { start: lineStart, end: lineEnd }));
        i = resume;
        while (i < r.end && items[i].ch === " " && !items[i].locked) {
            i++;
        }
    }
    return out;
}

/**
 * Wraps the flow at `width` screen cells; a blank flow gives no lines. `split` allows splitting an overlong word
 * (off when measuring min-content widths).
 */
export function wrapFlow(flow: Flow, width: number, split: boolean): FlowLine[] {
    let out: FlowLine[] = [];
    if (!flow.isBlank()) {
        out = hardLines(flow.items).reduce<FlowLine[]>((acc: FlowLine[], r: FlowLine): FlowLine[] => acc.concat(wrapRange(flow.items, r, Math.max(1, width), split)), []);
    }
    return out;
}

/** The buffer text of a line. */
export function lineText(items: readonly FlowItem[], r: FlowLine): string {
    let out: string = "";
    for (let k = r.start; k < r.end; k++) {
        out += items[k].ch;
    }
    return out;
}

/** Screen width of a line (buffer plus virtual cells). */
export function lineScreenWidth(items: readonly FlowItem[], r: FlowLine): number {
    let out: number = 0;
    for (let k = r.start; k < r.end; k++) {
        out += items[k].sw;
    }
    return out;
}
