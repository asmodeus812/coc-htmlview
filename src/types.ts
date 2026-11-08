/**
 * The data types shared across htmlview: what a rendered document is ({@link Layout} and its parts), the highlight group definitions the view applies. Plain data, no logic.
 */

/** Theme kinds for VS Code webview compatibility; selects the body class (`vscode-light`, `vscode-dark`, `vscode-high-contrast`). */
export type ThemeKind = "light" | "dark" | "high-contrast";

/** Which attribute of a linked highlight group holds a variable's colour. */
export type ColorAttr = "fg" | "bg" | "sp";

/** A colour as the view must apply it. */
export type ColorRef =
    | {
          /** A literal colour (`"#236a97"`), resolved at cascade time (theme palettes are resolved per themeKind). */
          hex: string;
          /** Opacity 0–1 from `rgba()`; the view blends `hex` over Normal's background. Absent = opaque. */
          alpha?: number;
      }
    | {
          /** A variable group (`"HtmlViewVscodeDiffEditorInsertedLineBackground"`), read live by the view. */
          group: string;
          /** Which attribute of that group (resolved through its link) supplies the colour. */
          attr: ColorAttr;
          /** Standard groups tried in order when the variable group yields no colour (from the host variable table). */
          fallback?: string[];
      };

/**
 * One highlight group to define. Either `link` (variable groups: `hi def link`, default semantics, so the user's
 * `:hi` wins) or attributes (class groups, redefined in full on every update and on ColorScheme).
 * An explicit `false` on a boolean attribute switches it off over an outer mark (see CONTRACT.md).
 */
export interface GroupDef {
    /** Group name, from {@link groupName}. */
    name: string;
    /** Link target; when set, all other fields are absent. */
    link?: string;
    /** Further links tried in order when `link` gives no colour (the native fallback chain). */
    fallback?: string[];
    fg?: ColorRef;
    bg?: ColorRef;
    /** Underline/undercurl colour (from `text-decoration-color`, `border-bottom-color` of links). */
    sp?: ColorRef;
    /** `font-weight` ≥ 600 (or `bold`/`bolder`). */
    bold?: boolean;
    /** `font-style: italic|oblique`. */
    italic?: boolean;
    /** `text-decoration: underline`. */
    underline?: boolean;
    /** `text-decoration: line-through`. */
    strikethrough?: boolean;
}

/** One highlight range. */
export interface Mark {
    /** 0-based line. */
    line: number;
    /** 0-based start cell, inclusive. Ignored when `lineHl`. */
    startCol: number;
    /** 0-based end cell, exclusive (`startCol < endCol`). Ignored when `lineHl`. */
    endCol: number;
    /** Highlight group (a `HtmlView*` name from the StyleMap, or a code-token group from highlight/). */
    group: string;
    /** Extmark priority; see `common.MarkPriority` for the bands. Absent = `MarkPriority.style`. */
    priority?: number;
    /** When true, `group` paints the whole screen line (`line_hl_group`), e.g. diff added/removed lines. */
    lineHl?: boolean;
}

/** Where activating a {@link Link} goes. */
export type LinkTarget =
    /** An external URL (`href` as written; opened by the view with the system opener). */
    | { kind: "url"; href: string }
    /** An in-document jump to the {@link Anchor} with this `id` (from `href="#id"`). */
    | { kind: "anchor"; id: string }
    /** Selects context `key` of the contexts node `contexts` (a context label in the bar); triggers a relayout. */
    | { kind: "context"; contexts: string; key: string };

/** An activatable range (`<a>`, a context label). Single-line: a wrapped link yields one Link per line. */
export interface Link {
    /** 0-based line. */
    line: number;
    /** 0-based start cell, inclusive. */
    startCol: number;
    /** 0-based end cell, exclusive. */
    endCol: number;
    target: LinkTarget;
}

/** A named line to jump to: headings (slug of their text, or their `id`), elements with `id`, tabs (`tab.key/i`). */
export interface Anchor {
    /** Unique within one Layout; duplicates get `-1`, `-2`, … suffixes. */
    id: string;
    /** 0-based line. */
    line: number;
    /** Heading level (1–6) for headings and tabs (tabs count as level 2); absent for other anchors. */
    level?: number;
    /** Display text (heading text, tab title), for a table of contents. */
    title?: string;
}

/**
 * A block of code to syntax-highlight. Code is never wrapped or reflowed: line `i` of `text` (split on `\n`) is
 * exactly the buffer text of line `startLine + i` starting at cell `startCol` (tabs already expanded).
 */
export interface CodeRegion {
    /** 0-based first line. */
    startLine: number;
    /** 0-based last line, inclusive (`endLine - startLine + 1` = number of lines of `text`). */
    endLine: number;
    /** 0-based cell where the code starts on every line of the region (after indent/quote/border prefixes). */
    startCol: number;
    /** Language name as in a code block's class or data-lang (`node.lang ?? LayoutOptions.defaultLang`); `""` when unknown. highlight/ maps it. */
    lang: string;
    /** The code exactly as laid out (tabs expanded, no trailing newline). */
    text: string;
}

/** A foldable line range (sections under headings, tabs, code blocks). */
export interface Fold {
    /** 0-based first line, inclusive. */
    startLine: number;
    /** 0-based last line, inclusive. */
    endLine: number;
}

/** A chunk of virtual text: text plus the groups painting it (`nvim_buf_set_extmark` virt_text chunk). */
export interface VirtChunk {
    text: string;
    /** Groups in increasing priority (a list, as nvim accepts). */
    groups: string[];
}

/**
 * Virtual text attached to a buffer position. Not part of `Layout.lines`: it is NOT yankable and does not shift
 * buffer columns, but `inline` virtual text DOES take screen cells, so layout counts its width when wrapping.
 */
export interface VirtText {
    line: number;
    /** Cell where it attaches (inline: inserted before this cell; overlay: drawn over from this cell). */
    col: number;
    pos: "inline" | "eol" | "overlay" | "right_align";
    chunks: VirtChunk[];
    /** What it shows, for the view's toggles: link targets, list markers, borders, other pseudo content. */
    role: "link-target" | "marker" | "border" | "pseudo";
    priority?: number;
}

/** Whole virtual lines above/below a buffer line (box top/bottom borders, margins that should not be buffer text). */
export interface VirtLines {
    line: number;
    above: boolean;
    lines: VirtChunk[][];
    role: "border" | "spacing";
}

/** Concealed buffer text (`conceal` extmark), optionally replaced by one cell `char`. */
export interface Conceal {
    line: number;
    startCol: number;
    endCol: number;
    char?: string;
}

/** Everything the view needs to show a document. Plain data. */
export interface Layout {
    /** Buffer lines (see module doc for guarantees). */
    lines: string[];
    /** Style and diff marks, in no particular order. Code-token marks are NOT here (highlight/ adds them). */
    marks: Mark[];
    links: Link[];
    anchors: Anchor[];
    /** One per code block / diff half, in document order; the index is the region id used by highlight/. */
    codeRegions: CodeRegion[];
    folds?: Fold[];
    /** Virtual text; link targets (`LayoutOptions.linkTarget`) painted with `HtmlViewHostLinkUrl` (@markup.link.url). Absent on a plain Layout. */
    virtText?: VirtText[];
    /** Whole virtual lines above/below buffer lines. Absent on a plain Layout. */
    virtLines?: VirtLines[];
    /** Concealed buffer text. Absent on a plain Layout. */
    conceals?: Conceal[];
}
