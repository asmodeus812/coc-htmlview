/**
 * The box engine: StyledTree → box tree → the `Layout` (virtText, virtLines and conceals filled).
 * Driven by computed `display` only; layout never checks a tag name (hints come as custom properties, see
 * `style.LayoutHint`).
 *
 * Block formatting: vertical margins → blank lines (adjacent sibling and parent/first-child margins collapse to
 * the max, as CSS); padding → indent cells / blank lines inside the box; borders → box-drawing characters in the
 * buffer for table grids, and virtual text where it keeps buffer text clean (see Layout.virtText); background →
 * marks over the box's whole rectangle (padding included, padded to the box width), so a `pre` is a rectangle.
 * Inline formatting: text collapsed per `white-space`, wrapped by display cells (`common.displayWidth`; CJK and
 * emoji 2 cells), break opportunities at spaces and after `-`, overlong words split only when nothing else fits;
 * `text-align` pads lines; each inline element's `paint` becomes marks over its ranges (one per line).
 * List items: `::marker` text placed outside (hanging indent of the marker width) or inside (`list-style-position`);
 * counters per CSS Lists (`list-item` implicit counter, `counter-reset/increment/set`, `content: counter()`).
 * Tables: CSS table model (caption, row groups, rows, cells; anonymous table boxes fill gaps), column widths from
 * min/max content, distributed to fit `width`; cells wrap; when even minimal columns do not fit, rows stack.
 * Flex: a row of items laid side by side when their max-content fits, otherwise stacked as blocks.
 * Code: an element with `--htmlview-code: block` emits one CodeRegion (never wrapped; tabs expanded with
 * `tabstop`); its language from the element's or its first child's `data-lang`/`lang` attribute or a
 * `language-x`/`lang-x` class, else `defaultLang`. Links: `--htmlview-link: href` → one Link per line of the
 * element's text (`#id` → anchor target, else url) plus a link-target virtual text (Layout.virtText). Anchors: every
 * element `id` attribute, and each `--htmlview-heading` element (slug of its text, `level` = the hint).
 * Folds: each heading's section, each code block.
 *
 * Pure and deterministic; no nvim.
 */
import type { StyledElement, StyledPseudo, StyledTree, ComputedStyle } from "../style";
import type { Anchor, CodeRegion, Conceal, Fold, Layout, Link, Mark, VirtText, VirtLines } from "../../types";
import { hostRoles } from "../style/host";
import { build } from "./build";
import { place } from "./place";
import { anchors as emitAnchors, codeRegions as emitCodeRegions, folds as emitFolds, links as emitLinks, virtual as emitVirtual } from "./emit";

// ---------------------------------------------------------------- box tree

interface BoxBase {
    /** DOM id of the generating element; absent for anonymous boxes. */
    element?: number;
    style: ComputedStyle;
    /** Paint groups (from the StyledElement / pseudo); anonymous boxes paint nothing. */
    paint: string[];
    /** The generating element's attributes, plus derived `data-htmlview-lang` / `data-htmlview-toggle` (build.ts); absent for anonymous boxes. */
    attrs?: Readonly<Record<string, string>>;
}

/** A block container (display block, flow-root parts of inline-block, the html/body boxes). */
export interface BlockBox extends BoxBase {
    kind: "block";
    /** All block-level or all inline-level (inline runs among blocks are wrapped in anonymous blocks). */
    children: Box[];
    /** True for anonymous block boxes wrapping an inline run. */
    anonymous?: boolean;
}

/** A list item: a block box with its marker. */
export interface ListItemBox extends BoxBase {
    kind: "list-item";
    marker?: MarkerBox;
    children: Box[];
}

/** The `::marker` of a list item (text already resolved: bullet, `3.`, a string, or `content`). */
export interface MarkerBox extends BoxBase {
    kind: "marker";
    text: string;
    position: "outside" | "inside";
}

/** An inline box (`span`, `a`, `code`, pseudo-elements with content). */
export interface InlineBox extends BoxBase {
    kind: "inline";
    children: Box[];
    /** Set for `::before`/`::after` boxes. */
    pseudo?: StyledPseudo["pseudo"];
}

/** An atomic inline (inline-block, replaced `img` as its alt text): laid out as a unit, never split. */
export interface AtomicInlineBox extends BoxBase {
    kind: "atomic";
    /** Block content of an inline-block, or the replaced text (`[alt]`). */
    children: Box[];
    replacedText?: string;
}

/** A run of text (inherits its parent box's style; `style` is that style). */
export interface TextBox extends BoxBase {
    kind: "text";
    text: string;
}

/** A forced break (`--htmlview-break: line`) or a break opportunity (`opportunity`). */
export interface BreakBox extends BoxBase {
    kind: "break";
    forced: boolean;
}

/** CSS table wrapper: caption(s) and the grid. */
export interface TableBox extends BoxBase {
    kind: "table";
    captions: BlockBox[];
    /** Rows in visual order (header groups first, footer groups last), anonymous rows/cells added where needed. */
    rows: TableRowBox[];
}

export interface TableRowBox extends BoxBase {
    kind: "table-row";
    /** Which row group the row came from (header rows get repeated nothing, but styled by their cells' `th`). */
    group: "header" | "body" | "footer";
    cells: TableCellBox[];
}

export interface TableCellBox extends BoxBase {
    kind: "table-cell";
    colspan: number;
    rowspan: number;
    children: Box[];
}

/** A flex container: a block whose items sit in rows at their shrink-to-fit widths, wrapping when the next does not fit. */
export interface FlexRowBox extends BoxBase {
    kind: "flex-row";
    items: Box[];
}

export type Box =
    | BlockBox
    | ListItemBox
    | MarkerBox
    | InlineBox
    | AtomicInlineBox
    | TextBox
    | BreakBox
    | TableBox
    | TableRowBox
    | TableCellBox
    | FlexRowBox;

/** Characters layout draws itself; every field has a plain-text default. */
export interface IconSet {
    /** Unordered list bullets by nesting depth (cycled); default `["•", "◦", "▪"]`. */
    bullets?: string[];
    /** Prefix of every blockquote line; default `"│ "`. */
    quote?: string;
    /** Character repeated for `<hr>` and table rules; default `"─"`. */
    rule?: string;
    /** Shown before an image's alt text; default `""` (alt text in brackets: `[alt]`). */
    image?: string;
}

/** Options of {@link layoutBoxes}. */
export interface LayoutOptions {
    /** Wrap width in cells. */
    width: number;
    /** Tab stop for code in cells; the default for elements without a `tab-size` (htmlview passes Neovim's 'tabstop'). */
    tabstop: number;
    /** Characters layout draws: `rule` (borders/hr), `bullets` fallback when no marker text, `image` prefix. */
    icons?: IconSet;
    /** Language name for code without its own (as in a code block's class or data-lang). */
    defaultLang?: string;
    /** Link target virtual text: default {@link DEFAULT_LINK_TARGET} (hidden; htmlview shows it per `htmlview.linkTargets`). */
    linkTarget?: { show: boolean; symbol: string };
    /**
     * Whether layout may move decorations out of buffer text into virtual text (markers, borders, link targets).
     * `false` (Vim, or a user choice) renders them as buffer text, the old way. Default true.
     */
    virtual?: boolean;
}

// ---------------------------------------------------------------- passes

/** A half-open cell range on one buffer line. */
export interface CellRange {
    line: number;
    startCol: number;
    endCol: number;
}

/** Where a box landed in the buffer. */
export interface PlacedBox {
    box: Box;
    /** First and last buffer line the box covers, inclusive (margins excluded, padding and borders included). */
    startLine: number;
    endLine: number;
    /** Cell where the box's content starts (after indents, borders, padding), on every line of the box. */
    contentCol: number;
    /** Cell width of the box's border box (backgrounds are painted over this rectangle). */
    width: number;
    /** Inline boxes and text: the ranges their text occupies, one per line, in order. Empty for blocks. */
    ranges: CellRange[];
    children: PlacedBox[];
}

/** The result of {@link placeBoxes}: buffer text, the paint marks, and the placed box tree. */
export interface PlacedTree {
    lines: string[];
    /** Paint marks of every box (`paint` groups, priority from {@link paintPriority}); code-token marks excluded. */
    marks: Mark[];
    root: PlacedBox;
}

/** Builds the box tree (display → box kind, anonymous boxes, markers, pseudo boxes). Pure. */
export function buildBoxes(styled: StyledTree): BlockBox {
    return build(styled);
}

/**
 * Places the box tree into `opts.width` cells: block and inline formatting, lists, tables, flex rows (see module
 * doc). Writes buffer text and paint marks; decorations that `opts.virtual` moves out of the text are left to
 * {@link emitVirtual} (their cells are NOT in `lines`, but inline virtual text widths ARE counted when wrapping).
 */
export function placeBoxes(root: BlockBox, opts: LayoutOptions): PlacedTree {
    return place(root, opts);
}

/** The virtual decorations of a Layout. */
export interface VirtualOutput {
    virtText: VirtText[];
    virtLines: VirtLines[];
    conceals: Conceal[];
}

/** Default link-target options: hidden, as a browser shows no link targets. */
export const DEFAULT_LINK_TARGET: Readonly<{ show: boolean; symbol: string }> = Object.freeze({ show: false, symbol: "🔗" });

/**
 * The inline virtual text after a url link: ` <symbol> <href>`, attached at the link's end cell, painted with the
 * linkUrl role group (`HtmlViewHostLinkUrl` → @markup.link.url → Underlined → Directory).
 */
export function linkTargetText(link: Link, symbol: string): VirtText | undefined {
    let out: VirtText | undefined;
    if (link.target.kind === "url") {
        out = {
            line: link.line,
            col: link.endCol,
            pos: "inline",
            chunks: [{ text: ` ${symbol} ${link.target.href}`, groups: [hostRoles.linkUrl.group] }],
            role: "link-target",
        };
    } else {
        out = undefined;
    }
    return out;
}

/**
 * Pipeline inside layout: `buildBoxes` (StyledTree → box tree) → `placeBoxes` (box tree → buffer text plus where
 * every box landed) → the emitters of emit.ts (each a pure function of the {@link PlacedTree}) → `layoutBoxes`
 * assembles the {@link Layout}. The emitters are separate so each output can be tested on a hand-made
 * PlacedTree without the placement engine.
 * Deterministic; never throws on a well-formed StyledTree.
 */
export function layoutBoxes(styled: StyledTree, opts: LayoutOptions): Layout {
    const tree: PlacedTree = placeBoxes(buildBoxes(styled), opts);
    const codeRegions: CodeRegion[] = emitCodeRegions(tree, opts);
    const links: Link[] = emitLinks(tree);
    const anchors: Anchor[] = emitAnchors(tree);
    const folds: Fold[] = emitFolds(tree, anchors, codeRegions);
    const virt: VirtualOutput = emitVirtual(tree, links, opts);
    return { lines: tree.lines, marks: tree.marks, links, anchors, codeRegions, folds, virtText: virt.virtText, virtLines: virt.virtLines, conceals: virt.conceals };
}

/** The priority of a paint group of an element at `depth` (root 0), `layer` its index in `paint`. */
export function paintPriority(styleBand: number, depth: number, layer: number): number {
    return styleBand + Math.min(99, depth * 4 + Math.min(3, layer));
}

/** Type re-export for callers that only need the element type with its style. */
export type { StyledElement };
