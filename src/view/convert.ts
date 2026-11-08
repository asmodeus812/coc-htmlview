/**
 * Pure conversions from layout/style data to what the editor takes: Marks → extmark tuples (cells → UTF-8 bytes),
 * GroupDefs → highlight specs (resolved on the Lua side) or Vim `:hi` arguments.
 */
import { MarkPriority, cellToByte, displayWidth } from "../common";
import type { Layout, Mark, VirtChunk, VirtLines, VirtText } from "../types";
import type { ColorAttr, ColorRef, GroupDef } from "../types";

/** One extmark as sent to Lua: `[line, byteCol, byteEndCol, group, priority, lineHl ? 1 : 0]`. */
export type ExtmarkTuple = [number, number, number, string, number, 0 | 1];

/** A colour as Lua resolves it: opaque hex, hex blended over Normal's background, or a live group attribute. */
export type ColorSpec = string | { hex: string; alpha: number } | { group: string; attr: ColorAttr; fallback?: string[] };

/**
 * Boolean attributes of an `nvim_set_hl` call. An explicit `false` in the GroupDef (`h1 {font-weight: 500}`,
 * `a {text-decoration: none}`) must switch off what an outer, lower-priority mark turned on, but nvim ORs the
 * attribute flags of overlapping extmarks. So such a group is defined with `nocombine = true`: where its mark
 * lies on top, its attribute flags replace the combined ones (colours still combine as usual: unset fg/bg/sp
 * shows the outer colour). Known cost: flags of outer marks the group does not mention are also dropped there.
 */
export interface HlAttrs {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    nocombine?: boolean;
}

/** A group definition for Lua `M.define`: a default link, or attributes plus colours to resolve. */
export type HlSpec =
    | { name: string; link: string; fallback?: string[]; only?: "fg" }
    | { name: string; attrs: HlAttrs; colors: Partial<Record<ColorAttr, ColorSpec>> };

/**
 * Converts marks (display cells) to extmark tuples (bytes). Marks on lines outside `lines`, or whose range is
 * empty in bytes, are dropped; `lineHl` marks keep only their line. Priority defaults to `MarkPriority.style`.
 */
export function toExtmarks(lines: string[], marks: Mark[]): ExtmarkTuple[] {
    const out: ExtmarkTuple[] = [];
    for (const mark of marks) {
        const text = lines[mark.line];
        const priority = mark.priority ?? MarkPriority.style;
        if (text !== undefined && mark.lineHl) {
            out.push([mark.line, 0, 0, mark.group, priority, 1]);
        } else if (text !== undefined) {
            const start = cellToByte(text, mark.startCol);
            const end = cellToByte(text, mark.endCol);
            if (start < end) {
                out.push([mark.line, start, end, mark.group, priority, 0]);
            }
        }
    }
    return out;
}

function colorSpec(ref: ColorRef): ColorSpec {
    let spec: ColorSpec;
    if ("group" in ref) {
        spec = ref.fallback !== undefined ? { group: ref.group, attr: ref.attr, fallback: ref.fallback } : { group: ref.group, attr: ref.attr };
    } else if (ref.alpha !== undefined && ref.alpha < 1) {
        spec = { hex: ref.hex, alpha: ref.alpha };
    } else {
        spec = ref.hex;
    }
    return spec;
}

/**
 * Converts a GroupDef to the spec Lua turns into `nvim_set_hl`: a link (a variable group) is defined with
 * `default = true`, so the user's `:hi` wins; attributes (a stylesheet group) are always redefined in full.
 */
export function toHlSpec(def: GroupDef): HlSpec {
    let spec: HlSpec;
    if (def.link !== undefined) {
        const link: HlSpec = def.fallback !== undefined && def.fallback.length > 0 ? { name: def.name, link: def.link, fallback: def.fallback } : { name: def.name, link: def.link };
        spec = def.only !== undefined ? { ...link, only: def.only } : link;
    } else {
        const attrs: HlAttrs = {};
        const colors: Partial<Record<ColorAttr, ColorSpec>> = {};
        for (const key of ["bold", "italic", "underline", "strikethrough"] as const) {
            const value = def[key];
            if (value !== undefined) {
                attrs[key] = value;
            }
        }
        if (attrs.bold === false || attrs.italic === false || attrs.underline === false || attrs.strikethrough === false) {
            attrs.nocombine = true;
        }
        for (const key of ["fg", "bg", "sp"] as const) {
            const ref = def[key];
            if (ref !== undefined) {
                colors[key] = colorSpec(ref);
            }
        }
        spec = { name: def.name, attrs, colors };
    }
    return spec;
}

function parseHex(hex: string): [number, number, number] {
    const n = parseInt(hex.replace(/^#/, "").slice(0, 6), 16) || 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Blends `hex` with opacity `alpha` over `base` (both `#rrggbb`), as the Lua side does. */
export function blendHex(hex: string, alpha: number, base: string): string {
    const top = parseHex(hex);
    const bottom = parseHex(base);
    const mixed = top.map((c, i) => Math.round(c * alpha + bottom[i] * (1 - alpha)));
    return "#" + mixed.map((c) => c.toString(16).padStart(2, "0")).join("");
}

/** The live colour lookups (`{group, attr}`) a set of specs needs, deduplicated, for the Vim path. */
export function liveRefs(specs: HlSpec[]): Array<{ group: string; attr: ColorAttr }> {
    const seen = new Set<string>();
    const refs: Array<{ group: string; attr: ColorAttr }> = [];
    for (const spec of specs) {
        const colors = "colors" in spec ? Object.keys(spec.colors).map((k) => spec.colors[k as ColorAttr]) : [];
        for (const color of colors) {
            const live = color !== undefined && typeof color === "object" && "group" in color ? color : undefined;
            const groups: string[] = live !== undefined ? [live.group].concat(live.fallback ?? []) : [];
            for (const group of groups) {
                const key = `${group}.${live!.attr}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    refs.push({ group, attr: live!.attr });
                }
            }
        }
    }
    return refs;
}

/**
 * The Vim `:hi` command for a spec: `hi def link A B` for a variable link (the user's `:hi` wins), or
 * `hi clear A | hi A guifg=… gui=bold` for a stylesheet group, always redefined in full. `live` maps
 * `group.attr` to a resolved `#rrggbb` (missing = not set); `normalBg` is the blend base.
 */
export function vimHiCommand(spec: HlSpec, live: Record<string, string>, normalBg: string): string {
    let cmd: string;
    if ("link" in spec) {
        cmd = `hi def link ${spec.name} ${spec.link}`;
    } else {
        const parts: string[] = [];
        const names: Record<ColorAttr, string> = { fg: "guifg", bg: "guibg", sp: "guisp" };
        for (const attr of ["fg", "bg", "sp"] as const) {
            const color = spec.colors[attr];
            let value: string | undefined;
            if (typeof color === "string") {
                value = color;
            } else if (color !== undefined && "group" in color) {
                value = [color.group].concat(color.fallback ?? []).map((g) => live[`${g}.${color.attr}`]).find((v) => !!v);
            } else if (color !== undefined) {
                value = blendHex(color.hex, color.alpha, normalBg);
            }
            if (value !== undefined) {
                parts.push(`${names[attr]}=${value}`);
            }
        }
        const gui: string[] = (["bold", "italic", "underline", "strikethrough", "nocombine"] as const).filter((k) => spec.attrs[k] === true);
        if (gui.length > 0) {
            parts.push(`gui=${gui.join(",")}`, `cterm=${gui.join(",")}`);
        }
        // `hi clear` first: a plain `:hi` merges into the old definition, a stylesheet group must be replaced
        cmd = `hi clear ${spec.name} | hi ${spec.name} ${parts.length > 0 ? parts.join(" ") : "gui=NONE"}`;
    }
    return cmd;
}

// ---------------------------------------------------------------- engine decorations (virtual text, lines, conceal)

/** A virt_text chunk as Lua takes it: `{text, groups}`. */
export type ChunkTuple = [string, string[]];

/**
 * One virtual text extmark: `[line, byteCol, pos, chunks, priority, winCol, role]`. `winCol` ≥ 0 places an overlay at a
 * window column (`virt_text_win_col`) when the buffer line is shorter than the cell it covers; else -1. `role` is the
 * entry's {@link VirtText.role} (the view picks the legacy fallback position from it).
 */
export type VirtTuple = [number, number, VirtText["pos"], ChunkTuple[], number, number, VirtText["role"]];

/** Virtual lines: `[line, above ? 1 : 0, lines]`. */
export type VirtLinesTuple = [number, 0 | 1, ChunkTuple[][]];

/** A conceal: `[line, byteCol, byteEndCol, char]` (`""` hides the text). */
export type ConcealTuple = [number, number, number, string];

/** Everything the Lua side places besides the highlight marks. */
export interface Decorations {
    virt: VirtTuple[];
    virtLines: VirtLinesTuple[];
    conceals: ConcealTuple[];
}

function chunkTuples(chunks: VirtChunk[]): ChunkTuple[] {
    return chunks.map((c: VirtChunk): ChunkTuple => [c.text, c.groups.slice()]);
}

/**
 * Converts the engine's decorations to extmark tuples (cells → bytes). Entries on lines outside `lines` are dropped;
 * an overlay starting past the end of its line keeps the cell as a window column.
 */
export function toDecorations(layout: Layout): Decorations {
    const lines = layout.lines;
    const virt: VirtTuple[] = [];
    for (const vt of layout.virtText ?? []) {
        const text = lines[vt.line];
        if (text !== undefined) {
            const past = vt.col > displayWidth(text);
            const winCol = vt.pos === "overlay" && past ? vt.col : -1;
            virt.push([vt.line, cellToByte(text, vt.col), vt.pos, chunkTuples(vt.chunks), vt.priority ?? MarkPriority.ui, winCol, vt.role]);
        }
    }
    const virtLines: VirtLinesTuple[] = (layout.virtLines ?? [])
        .filter((v: VirtLines): boolean => lines[v.line] !== undefined)
        .map((v: VirtLines): VirtLinesTuple => [v.line, v.above ? 1 : 0, v.lines.map(chunkTuples)]);
    const conceals: ConcealTuple[] = [];
    for (const c of layout.conceals ?? []) {
        const text = lines[c.line];
        const start = text !== undefined ? cellToByte(text, c.startCol) : 0;
        const end = text !== undefined ? cellToByte(text, c.endCol) : 0;
        if (text !== undefined && start < end) {
            conceals.push([c.line, start, end, c.char ?? ""]);
        }
    }
    return { virt, virtLines, conceals };
}

/** The empty decoration set (nothing to place). */
export function noDecorations(): Decorations {
    return { virt: [], virtLines: [], conceals: [] };
}

/** `line` split at display cell `cell` (padded with spaces when shorter). */
function splitAt(line: string, cell: number): [string, string] {
    const width = displayWidth(line);
    const padded = width < cell ? line + " ".repeat(cell - width) : line;
    const byte = cellToByte(padded, cell);
    const buf = Buffer.from(padded, "utf8");
    return [buf.subarray(0, byte).toString("utf8"), buf.subarray(byte).toString("utf8")];
}

/** Marks painting an inserted chunk sequence at (`line`, `col`), one per group (groups in increasing priority). */
function chunkMarks(line: number, col: number, chunks: VirtChunk[], priority: number): Mark[] {
    const out: Mark[] = [];
    let at = col;
    for (const chunk of chunks) {
        const w = displayWidth(chunk.text);
        chunk.groups.forEach((group: string, i: number): void => {
            out.push({ line, startCol: at, endCol: at + w, group, priority: priority + i });
        });
        at += w;
    }
    return out;
}

/** Shifts a cell range on `line` for `width` cells inserted at `col` (a range spanning `col` grows). */
function shiftRange<T extends { line: number; startCol: number; endCol: number }>(item: T, line: number, col: number, width: number): T {
    let out: T = item;
    if (item.line === line && item.startCol >= col) {
        out = { ...item, startCol: item.startCol + width, endCol: item.endCol + width };
    } else if (item.line === line && item.endCol > col) {
        out = { ...item, endCol: item.endCol + width };
    }
    return out;
}

/** Puts one virtual text into the buffer text of `layout` (see {@link flattenVirtual}). */
function flattenOne(layout: Layout, vt: VirtText): Layout {
    const text = vt.chunks.map((c: VirtChunk): string => c.text).join("");
    const width = displayWidth(text);
    const line = layout.lines[vt.line] ?? "";
    const lineWidth = displayWidth(line);
    const col = vt.pos === "eol" || vt.pos === "right_align" ? lineWidth + (vt.pos === "eol" ? 1 : 0) : vt.col;
    const [before, after] = splitAt(line, col);
    const [covered, rest] = splitAt(after, width);
    // an overlay over blank cells (a list marker in the indent) replaces them; anything else is inserted
    const replace = vt.pos === "overlay" && covered.trim() === "";
    const lines = layout.lines.slice();
    lines[vt.line] = replace ? before + text + rest : before + text + after;
    const shift = replace ? 0 : width;
    const marks = layout.marks.map((m: Mark): Mark => (m.lineHl ? m : shiftRange(m, vt.line, col, shift)));
    return {
        ...layout,
        lines,
        marks: marks.concat(chunkMarks(vt.line, col, vt.chunks, vt.priority ?? MarkPriority.ui)),
        links: layout.links.map((l) => shiftRange(l, vt.line, col, shift)),
    };
}

/** Inserts whole lines for `vl` into `layout`, moving every line-based item below them down. */
function flattenLines(layout: Layout, vl: VirtLines): Layout {
    const at = vl.above ? vl.line : vl.line + 1;
    const n = vl.lines.length;
    const move = (line: number): number => (line >= at ? line + n : line);
    const added: string[] = vl.lines.map((chunks: VirtChunk[]): string => chunks.map((c) => c.text).join(""));
    const lines = layout.lines.slice(0, at).concat(added, layout.lines.slice(at));
    const newMarks: Mark[] = vl.lines.flatMap((chunks: VirtChunk[], i: number): Mark[] => chunkMarks(at + i, 0, chunks, MarkPriority.style));
    return {
        ...layout,
        lines,
        marks: layout.marks.map((m: Mark): Mark => ({ ...m, line: move(m.line) })).concat(newMarks),
        links: layout.links.map((l) => ({ ...l, line: move(l.line) })),
        anchors: layout.anchors.map((a) => ({ ...a, line: move(a.line) })),
        codeRegions: layout.codeRegions.map((r) => ({ ...r, startLine: move(r.startLine), endLine: move(r.endLine) })),
        folds: layout.folds?.map((f) => ({ startLine: move(f.startLine), endLine: move(f.endLine) })),
    };
}

/**
 * The Vim fallback (no extmark virtual text): every virtual text becomes buffer text (inline and eol inserted,
 * an overlay over blank cells replacing them), virtual lines become buffer lines, conceals are dropped. Entries
 * are applied right to left and bottom to top, so earlier positions stay valid. The result has no decorations.
 */
export function flattenVirtual(layout: Layout): Layout {
    const texts = (layout.virtText ?? []).filter((v: VirtText): boolean => layout.lines[v.line] !== undefined);
    const ordered = texts.slice().sort((a: VirtText, b: VirtText): number => b.line - a.line || b.col - a.col);
    let out: Layout = { lines: layout.lines, marks: layout.marks, links: layout.links, anchors: layout.anchors, codeRegions: layout.codeRegions, folds: layout.folds };
    for (const vt of ordered) {
        out = flattenOne(out, vt);
    }
    const blocks = (layout.virtLines ?? []).filter((v: VirtLines): boolean => layout.lines[v.line] !== undefined);
    const bottomUp = blocks.slice().sort((a: VirtLines, b: VirtLines): number => b.line - a.line || (a.above ? 1 : 0) - (b.above ? 1 : 0));
    for (const vl of bottomUp) {
        out = flattenLines(out, vl);
    }
    return out;
}
