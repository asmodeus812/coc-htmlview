/**
 * Shared primitives of htmlview: the display-cell convention and the extmark priority bands.
 *
 * This is the coordinate contract: every part that measures text (layout, highlight, view) uses these functions,
 * so a column computed by one part means the same thing in every other part.
 */

/**
 * Extmark priority bands. A mark's priority is `band + offset`, the offset staying below the gap to the next
 * band (< 100). Neovim draws the higher priority on top when highlights overlap (`hl_mode` combine).
 */
export const MarkPriority = {
    /** `lineHl` marks (diff added/removed line backgrounds), under everything else. */
    line: 100,
    /** Style marks from the cascade; offset = nesting depth of the element, so inner elements win. */
    style: 200,
    /** Code-token marks (hljs or treesitter); above style so syntax colours sit on top of block backgrounds. */
    code: 300,
    /** Interactive marks the view adds (selected context label, cursor-related); always on top. */
    ui: 400,
} as const;

/** Inclusive code point ranges rendered two cells wide (East Asian Wide/Fullwidth and emoji presentation). */
const WIDE: ReadonlyArray<readonly [number, number]> = [
    [0x1100, 0x115f],
    [0x231a, 0x231b],
    [0x2329, 0x232a],
    [0x23e9, 0x23ec],
    [0x23f0, 0x23f0],
    [0x23f3, 0x23f3],
    [0x25fd, 0x25fe],
    [0x2614, 0x2615],
    [0x2648, 0x2653],
    [0x267f, 0x267f],
    [0x2693, 0x2693],
    [0x26a1, 0x26a1],
    [0x26aa, 0x26ab],
    [0x26bd, 0x26be],
    [0x26c4, 0x26c5],
    [0x26ce, 0x26ce],
    [0x26d4, 0x26d4],
    [0x26ea, 0x26ea],
    [0x26f2, 0x26f3],
    [0x26f5, 0x26f5],
    [0x26fa, 0x26fa],
    [0x26fd, 0x26fd],
    [0x2705, 0x2705],
    [0x270a, 0x270b],
    [0x2728, 0x2728],
    [0x274c, 0x274c],
    [0x274e, 0x274e],
    [0x2753, 0x2755],
    [0x2757, 0x2757],
    [0x2795, 0x2797],
    [0x27b0, 0x27b0],
    [0x27bf, 0x27bf],
    [0x2b1b, 0x2b1c],
    [0x2b50, 0x2b50],
    [0x2b55, 0x2b55],
    [0x2e80, 0x303e],
    [0x3041, 0x33ff],
    [0x3400, 0x4dbf],
    [0x4e00, 0x9fff],
    [0xa000, 0xa4cf],
    [0xa960, 0xa97f],
    [0xac00, 0xd7a3],
    [0xf900, 0xfaff],
    [0xfe10, 0xfe19],
    [0xfe30, 0xfe6f],
    [0xff00, 0xff60],
    [0xffe0, 0xffe6],
    [0x1f004, 0x1f004],
    [0x1f0cf, 0x1f0cf],
    [0x1f18e, 0x1f18e],
    [0x1f191, 0x1f19a],
    [0x1f200, 0x1f251],
    [0x1f300, 0x1f64f],
    [0x1f680, 0x1f6ff],
    [0x1f900, 0x1f9ff],
    [0x1fa70, 0x1faff],
    [0x20000, 0x3fffd],
];

/** Inclusive code point ranges rendered zero cells wide (combining marks, joiners, variation selectors). */
const ZERO: ReadonlyArray<readonly [number, number]> = [
    [0x0300, 0x036f],
    [0x0483, 0x0489],
    [0x0591, 0x05bd],
    [0x0610, 0x061a],
    [0x064b, 0x065f],
    [0x200b, 0x200f],
    [0x20d0, 0x20ff],
    [0xfe00, 0xfe0f],
    [0xfe20, 0xfe2f],
    [0xe0100, 0xe01ef],
];

function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
    let lo = 0;
    let hi = ranges.length - 1;
    let found = false;
    while (!found && lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (cp < ranges[mid][0]) {
            hi = mid - 1;
        } else if (cp > ranges[mid][1]) {
            lo = mid + 1;
        } else {
            found = true;
        }
    }
    return found;
}

/**
 * Display width in cells of one code point: 0 for control/combining, 2 for wide, else 1. Tab is NOT handled
 * here (layout expands tabs to spaces before measuring; buffer lines never contain a tab).
 */
export function codePointWidth(cp: number): number {
    let width = 1;
    if (cp === 0 || cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || inRanges(cp, ZERO)) {
        width = 0;
    } else if (cp >= 0x1100 && inRanges(cp, WIDE)) {
        width = 2;
    }
    return width;
}

/** Display width in cells of a string (sum of {@link codePointWidth}, iterating by code point). */
export function displayWidth(text: string): number {
    let width = 0;
    for (const ch of text) {
        width += codePointWidth(ch.codePointAt(0) as number);
    }
    return width;
}

/**
 * Converts a display-cell column of `line` into a UTF-8 byte column (what extmarks take). A cell inside a wide
 * character maps to that character's start byte; a cell past the end maps to the line's byte length.
 */
export function cellToByte(line: string, cell: number): number {
    let cells = 0;
    let bytes = 0;
    for (const ch of line) {
        const w = codePointWidth(ch.codePointAt(0) as number);
        if (cells + w > cell) {
            break;
        }
        cells += w;
        bytes += Buffer.byteLength(ch, "utf8");
    }
    return bytes;
}

/** Converts a UTF-8 byte column of `line` to a display cell (a byte inside a character maps to its start cell). */
export function byteToCell(line: string, byte: number): number {
    let cells = 0;
    let bytes = 0;
    for (const ch of line) {
        const size = Buffer.byteLength(ch, "utf8");
        if (bytes + size <= byte) {
            cells += codePointWidth(ch.codePointAt(0) as number);
        }
        bytes += size;
    }
    return cells;
}
