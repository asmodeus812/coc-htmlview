/**
 * The emitters: pure functions of the PlacedTree (code regions, links, anchors, folds, virtual decorations).
 */
import { codePointWidth } from "../../common";
import type { Anchor, CodeRegion, Fold, Link, LinkTarget, VirtText } from "../../types";
import type { ComputedStyle } from "../style";
import { LayoutHint } from "../style";
import { ATTR_LANG, ATTR_TOGGLE } from "./build";
import type { CellRange, LayoutOptions, PlacedBox, PlacedTree, VirtualOutput } from "./index";
import { DEFAULT_LINK_TARGET, linkTargetText } from "./index";
import { markerDisplay, markerGroups, resolveOpts } from "./place";

/** Preorder walk; `fn` returns false to skip the children. */
function walk(p: PlacedBox, fn: (p: PlacedBox) => boolean): void {
    if (fn(p)) {
        p.children.forEach((c: PlacedBox): void => walk(c, fn));
    }
}

/** True for boxes that carry an element's own resolved style (not text, not markers). */
function own(p: PlacedBox): boolean {
    return p.box.kind !== "text" && p.box.kind !== "marker";
}

/** The text of `line` in cells `[start, end)` (end -1 = to the end). */
export function sliceCells(line: string, start: number, end: number): string {
    let cell: number = 0;
    let out: string = "";
    for (const ch of line) {
        const w: number = codePointWidth(ch.codePointAt(0) as number);
        if (cell >= start && (end < 0 || cell + w <= end)) {
            out += ch;
        }
        cell += w;
    }
    return out;
}

/**
 * One CodeRegion per box whose style has `--htmlview-code: block`, in document order (the index is the region id
 * highlight/ uses). Language: see module doc (`defaultLang` last, `""` when none).
 */
export function codeRegions(tree: PlacedTree, opts: LayoutOptions): CodeRegion[] {
    const out: CodeRegion[] = [];
    walk(tree.root, (p: PlacedBox): boolean => {
        const s: ComputedStyle = p.box.style;
        const code: boolean = own(p) && s.custom[LayoutHint.code] === "block";
        if (code) {
            const top: number = p.startLine + (s.border.top.width > 0 ? 1 : 0) + Math.max(0, s.padding.top);
            const bottom: number = p.endLine - (s.border.bottom.width > 0 ? 1 : 0) - Math.max(0, s.padding.bottom);
            const x: number = p.contentCol - Math.max(0, s.padding.left) - (s.border.left.width > 0 ? 1 : 0);
            const end: number = s.border.right.width > 0 ? x + p.width - 1 : -1;
            const text: string[] = [];
            for (let line = top; line <= bottom; line++) {
                text.push(sliceCells(tree.lines[line] ?? "", p.contentCol, end).replace(/ +$/, ""));
            }
            if (text.length > 0) {
                const lang: string = p.box.attrs?.[ATTR_LANG] ?? "";
                out.push({ startLine: top, endLine: bottom, startCol: p.contentCol, lang: lang !== "" ? lang : opts.defaultLang ?? "", text: text.join("\n") });
            }
        }
        return !code;
    });
    return out;
}

/** The text ranges of a box: its own, else its descendants' merged per line (markers and empty ranges excluded). */
function textRanges(p: PlacedBox): CellRange[] {
    let out: CellRange[];
    if (p.ranges.length > 0 && p.box.kind !== "marker") {
        out = p.ranges.filter((r: CellRange): boolean => r.endCol > r.startCol);
    } else {
        const byLine: Map<number, CellRange> = new Map();
        p.children
            .filter((c: PlacedBox): boolean => c.box.kind !== "marker")
            .forEach((c: PlacedBox): void => {
                textRanges(c).forEach((r: CellRange): void => {
                    const cur: CellRange | undefined = byLine.get(r.line);
                    byLine.set(r.line, cur === undefined ? r : { line: r.line, startCol: Math.min(cur.startCol, r.startCol), endCol: Math.max(cur.endCol, r.endCol) });
                });
            });
        out = [...byLine.values()].sort((a: CellRange, b: CellRange): number => a.line - b.line);
    }
    return out;
}

/**
 * Links: per box with `--htmlview-link: href`, one Link per range of its text (`#id` → anchor, else url). Also
 * radio/checkbox toggles (`--htmlview-toggle`) as `{kind: "context"}` targets, keys per interact/.
 */
export function links(tree: PlacedTree): Link[] {
    const out: Link[] = [];
    walk(tree.root, (p: PlacedBox): boolean => {
        const c: Readonly<Record<string, string>> = p.box.style.custom;
        const attrs: Readonly<Record<string, string>> = p.box.attrs ?? {};
        const linkAttr: string | undefined = c[LayoutHint.link];
        const href: string | undefined = linkAttr !== undefined ? attrs[linkAttr.trim()] : undefined;
        let target: LinkTarget | undefined;
        if (own(p) && href !== undefined) {
            target = href.startsWith("#") ? { kind: "anchor", id: href.slice(1) } : { kind: "url", href };
        } else if (own(p) && attrs[ATTR_TOGGLE] !== undefined && attrs.for !== undefined) {
            target = { kind: "context", contexts: attrs[ATTR_TOGGLE], key: attrs.for };
        }
        if (target !== undefined) {
            const t: LinkTarget = target;
            textRanges(p).forEach((r: CellRange): void => {
                out.push({ line: r.line, startCol: r.startCol, endCol: r.endCol, target: t });
            });
        }
        return true;
    });
    return out;
}

/** Heading slug. */
export function slug(text: string): string {
    const plain: string = text
        .toLowerCase()
        .replace(/[!-,./:-@[-^`{-~]/g, "")
        .trim()
        .replace(/\s+/g, "-");
    return plain === "" ? "section" : plain;
}

/** The text of a box without generated content (pseudo-elements, markers), whitespace collapsed. */
function plainText(tree: PlacedTree, p: PlacedBox): string {
    const parts: string[] = [];
    walk(p, (q: PlacedBox): boolean => {
        const generated: boolean = q.box.kind === "marker" || (q.box.kind === "inline" && q.box.pseudo !== undefined);
        if (!generated && q.box.kind === "text") {
            q.ranges.forEach((r: CellRange): void => {
                parts.push(sliceCells(tree.lines[r.line] ?? "", r.startCol, r.endCol));
            });
        }
        return !generated;
    });
    return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Anchors: every element `id` and every `--htmlview-heading` box (slug of its text, unique with `-n` suffixes). */
export function anchors(tree: PlacedTree): Anchor[] {
    const out: Anchor[] = [];
    const seen: Map<string, number> = new Map();
    const unique = (id: string): string => {
        const n: number = seen.get(id) ?? 0;
        seen.set(id, n + 1);
        return n === 0 ? id : `${id}-${n}`;
    };
    walk(tree.root, (p: PlacedBox): boolean => {
        const c: Readonly<Record<string, string>> = p.box.style.custom;
        const level: number = own(p) ? parseInt(c[LayoutHint.heading] ?? "", 10) : NaN;
        const id: string | undefined = own(p) && p.box.attrs?.id !== undefined && p.box.attrs.id !== "" ? p.box.attrs.id : undefined;
        const ranges: CellRange[] = textRanges(p);
        const line: number = ranges.length > 0 ? ranges[0].line : p.startLine;
        if (!Number.isNaN(level) && level >= 1 && level <= 6) {
            const title: string = plainText(tree, p);
            out.push({ id: unique(id ?? slug(title)), line, level, title });
        } else if (id !== undefined) {
            out.push({ id: unique(id), line });
        }
        return true;
    });
    return out;
}

/** Folds: each heading's section (up to the next heading of the same or a higher level) and each code region. */
export function folds(tree: PlacedTree, anchorList: readonly Anchor[], regions: readonly CodeRegion[]): Fold[] {
    const out: Fold[] = [];
    const headings: Anchor[] = anchorList.filter((a: Anchor): boolean => a.level !== undefined);
    headings.forEach((h: Anchor, i: number): void => {
        const next: Anchor | undefined = headings.slice(i + 1).find((a: Anchor): boolean => (a.level as number) <= (h.level as number));
        let end: number = next !== undefined ? next.line - 1 : tree.lines.length - 1;
        while (end > h.line && (tree.lines[end] ?? "") === "") {
            end--;
        }
        if (end > h.line) {
            out.push({ startLine: h.line, endLine: end });
        }
    });
    regions.forEach((r: CodeRegion): void => {
        if (r.endLine > r.startLine) {
            out.push({ startLine: r.startLine, endLine: r.endLine });
        }
    });
    return out.sort((a: Fold, b: Fold): number => a.startLine - b.startLine || b.endLine - a.endLine);
}

/**
 * Virtual decorations: link targets (`linkTargetText` after the last range of each url link, when
 * `linkTarget.show`), outside markers and box borders when `opts.virtual` is not false, and conceals. With
 * `virtual: false` only link targets remain (as virtual text; buffer-text fallbacks are placeBoxes' job).
 */
export function virtual(tree: PlacedTree, linkList: readonly Link[], opts: LayoutOptions): VirtualOutput {
    const target: { show: boolean; symbol: string } = opts.linkTarget ?? DEFAULT_LINK_TARGET;
    const virtText: VirtText[] = [];
    if (target.show) {
        linkList.forEach((l: Link, i: number): void => {
            const next: Link | undefined = linkList[i + 1];
            const href: string = l.target.kind === "url" ? l.target.href : "";
            const continued: boolean = next !== undefined && next.target.kind === "url" && next.target.href === href && next.line === l.line + 1;
            const vt: VirtText | undefined = continued ? undefined : linkTargetText(l, target.symbol);
            if (vt !== undefined) {
                virtText.push(vt);
            }
        });
    }
    if (opts.virtual !== false) {
        const ro: ReturnType<typeof resolveOpts> = resolveOpts(opts);
        walk(tree.root, (p: PlacedBox): boolean => {
            const r: CellRange | undefined = p.ranges[0];
            if (p.box.kind === "marker" && r !== undefined && r.startCol === r.endCol) {
                virtText.push({
                    line: r.line,
                    col: r.startCol,
                    pos: p.box.position === "outside" ? "overlay" : "inline",
                    chunks: [{ text: markerDisplay(p.box, ro), groups: markerGroups(p.box) }],
                    role: "marker",
                });
            }
            return true;
        });
    }
    return { virtText: virtText.sort((a: VirtText, b: VirtText): number => a.line - b.line || a.col - b.col), virtLines: [], conceals: [] };
}
