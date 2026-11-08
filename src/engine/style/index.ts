/**
 * Computed style: the cascade's winning declarations (css/) typed, resolved and inherited, per element and
 * pseudo-element, plus the highlight groups the view defines. The user-agent sheet (`ua.css`, this folder) and
 * the host-theme group table (`host.ts`) belong here.
 *
 * Units: every length is computed into CELLS (horizontal) or LINES (vertical) by {@link lengthToCells}; layout
 * never sees CSS units. Colours: {@link Color}. Fonts: sizes and families are out of scope (terminal);
 * `font-weight` ≥ 600 renders bold.
 *
 * Highlight groups (the naming rule of today's `style/groupName`, kept): every rule selector that sets a visual
 * property (color, background-color, font-weight, font-style, text-decoration*, border colours for drawn borders)
 * gets a group `HtmlView<Pascal(selector.text)>` defined with THAT RULE's visual declarations (vars resolved
 * to variable groups); a selector list yields one group per member, identical definitions. Each host variable
 * gets `HtmlView<Pascal(var)>` linked to its role group (`host.ts`), each role group `HtmlViewHost<Role>`
 * links down its native chain. Inline `style=""` gets `HtmlViewInline<hash of its visual declarations>`.
 * A {@link StyledElement} paints with `paint`: its matched rule groups in cascade order (lowest first), so a user
 * `:hi HtmlViewImpactHigh` overrides exactly what that rule styles, and nesting gives inheritance (inner marks
 * sit higher, see CONTRACT.md "Coordinates").
 *
 * Pure and synchronous; no nvim; never throws on bad values (the declaration is dropped).
 */
import type { DomDocument, DomElement } from "../dom";
import type { Origin, Stylesheet as ParsedSheet } from "../css";
import type { FormState } from "../interact";
import type { GroupDef, ThemeKind } from "../../types";
import type { HostVarTable } from "./host";
import { computeStyles as runStyles, parseSheets as runParse } from "./compute";
export { markerText } from "./values";
import UA_TEXT from "./ua.css";

/** The user-agent sheet text (`ua.css`, bundled as text); {@link parseSheets} parses it first with origin `ua`. */
export const UA_SHEET: string = UA_TEXT;

// ---------------------------------------------------------------- values

/** Which attribute of a highlight group a colour is read from / written to. */
export type ColorAttr = "fg" | "bg" | "sp";

/**
 * A computed colour.
 * - `{hex, alpha}`: a literal (`#rgb[a]`, `rgb[a]()`, `hsl[a]()`, named, `transparent` = alpha 0), true colour;
 *   alpha < 1 is blended by the view over the background beneath (the nearest painted ancestor background, else
 *   the canvas).
 * - `{var}`: a host variable from the var table (`--vscode-*`/`--htmlview-*`), left for the colorscheme; the view
 *   reads it through the variable's group.
 * - `{group}`: a host role group directly (`HtmlViewHostLink`), for values the engine itself defaults.
 * `currentcolor` is resolved during computation (to the element's computed `color`).
 */
export type Color =
    | { hex: string; alpha: number }
    | { var: string; attr: ColorAttr }
    | { group: string; attr: ColorAttr };

export type Display =
    | "none"
    | "block"
    | "inline"
    | "inline-block"
    | "list-item"
    | "table"
    | "table-caption"
    | "table-header-group"
    | "table-row-group"
    | "table-footer-group"
    | "table-row"
    | "table-cell"
    /** `flex` and `inline-flex` (row direction only; `flex-direction: column` computes to `block`). */
    | "flex"
    | "contents";

export type WhiteSpace = "normal" | "nowrap" | "pre" | "pre-wrap" | "pre-line";
export type TextAlign = "left" | "right" | "center" | "justify";
export type BorderStyle = "none" | "solid" | "dashed" | "dotted" | "double";
export type Visibility = "visible" | "hidden" | "collapse";
export type ListStylePosition = "outside" | "inside";
/** `none`, the CSS counter styles layout draws, or a literal string marker (`list-style-type: "→ "`). */
export type ListStyleType =
    | "none"
    | "disc"
    | "circle"
    | "square"
    | "decimal"
    | "decimal-leading-zero"
    | "lower-alpha"
    | "upper-alpha"
    | "lower-roman"
    | "upper-roman"
    | { string: string };

/** Four sides in cells (left/right) and lines (top/bottom). */
export interface Edges {
    top: number;
    right: number;
    bottom: number;
    left: number;
}

export interface BorderSide {
    style: BorderStyle;
    /** Cells/lines: any visible width computes to 1 (a box-drawing character). 0 when style is none. */
    width: number;
    color: Color;
}

export interface Borders {
    top: BorderSide;
    right: BorderSide;
    bottom: BorderSide;
    left: BorderSide;
}

export interface TextDecoration {
    underline: boolean;
    lineThrough: boolean;
    overline: boolean;
    /** `text-decoration-color`; absent = currentcolor. Feeds `sp`. */
    color?: Color;
}

/** One piece of a `content` value. */
export type ContentItem =
    | { kind: "string"; text: string }
    | { kind: "attr"; name: string }
    | { kind: "counter"; name: string; style: ListStyleType }
    | { kind: "counters"; name: string; separator: string; style: ListStyleType }
    | { kind: "open-quote" }
    | { kind: "close-quote" };

/** `counter-reset` / `counter-increment` / `counter-set` entry. */
export interface CounterOp {
    name: string;
    value: number;
}

/**
 * The full computed property set. Every field always has a value (initial values in {@link initialStyle});
 * inherited ones are listed in {@link inheritedProperties}.
 */
export interface ComputedStyle {
    display: Display;
    visibility: Visibility;
    margin: Edges;
    padding: Edges;
    border: Borders;
    color: Color;
    /** `background-color` (`background` shorthand: its colour only); alpha 0 = no background. */
    backgroundColor: Color;
    /** 100–900; `bold` = 700, `normal` = 400, `bolder`/`lighter` resolved against the parent. */
    fontWeight: number;
    fontStyle: "normal" | "italic";
    textDecoration: TextDecoration;
    whiteSpace: WhiteSpace;
    /** `tab-size` in cells (a positive integer); 0 = not set, layout uses the host default (Neovim's 'tabstop'). */
    tabSize: number;
    textAlign: TextAlign;
    /** `text-transform` (cheap and visible in a terminal). */
    textTransform: "none" | "uppercase" | "lowercase" | "capitalize";
    listStyleType: ListStyleType;
    listStylePosition: ListStylePosition;
    /** `order` (flex items; the row is laid out in ascending order, ties in document order). */
    order: number;
    /** `width: 100%` (a flex item with it takes a row of its own). */
    fill: boolean;
    /** `content` (pseudo-elements only; `normal`/`none` = undefined). `::marker` default content is layout's. */
    content?: ContentItem[];
    counterReset: CounterOp[];
    counterIncrement: CounterOp[];
    counterSet: CounterOp[];
    /** Custom properties in scope (inherited, already var()-substituted), including the engine's layout hints. */
    custom: Readonly<Record<string, string>>;
}

/** An element (or pseudo-element) with its computed style and its paint groups. */
export interface StyledElement {
    kind: "element";
    /** The DOM element (pseudo-elements point at their originating element). */
    element: DomElement;
    style: ComputedStyle;
    /** Rule/inline groups that paint this element, lowest precedence first (see module doc). */
    paint: string[];
    /** `::before` / `::after` (only when `content` computes to something) and `::marker` (list items only). */
    before?: StyledPseudo;
    after?: StyledPseudo;
    marker?: StyledPseudo;
    children: StyledNode[];
}

export interface StyledPseudo {
    kind: "pseudo";
    pseudo: "before" | "after" | "marker";
    style: ComputedStyle;
    paint: string[];
    /** The content resolved to text (attr(), counters, quotes evaluated; markers: the list-style marker). */
    text: string;
}

/** Text inherits its parent's style; it carries no own style. */
export interface StyledText {
    kind: "text";
    text: string;
    /** DOM id of the text node. */
    id: number;
}

export type StyledNode = StyledElement | StyledText;

/** The result of {@link computeStyles}. */
export interface StyledTree {
    /** The `html` element; `body` gets the theme class (`vscode-<themeKind>`) before matching. */
    root: StyledElement;
    /** Every group used by any `paint` (role and variable groups first, then rule groups). */
    groups: GroupDef[];
}

/** The environment the cascade runs in. */
export interface StyleEnv {
    themeKind: ThemeKind;
    /** Host variable → role table (default: `defaultHostVars` in `host.ts`). */
    vars: HostVarTable;
}

/** A sheet as given to the engine, before parsing. */
export interface SheetSource {
    name: string;
    text: string;
    origin: Exclude<Origin, "inline">;
}

/**
 * Runs the cascade over `doc`: the UA sheet first, then `sheets` in order, then the document's `<style>`s
 * (author), then inline styles; `:checked` from `state`. Pure: same inputs, same tree. Callers may cache parsed
 * sheets (see {@link parseSheets}).
 */
export function computeStyles(doc: DomDocument, sheets: readonly ParsedSheet[], env: StyleEnv, state: FormState): StyledTree {
    return runStyles(doc, sheets, env, state);
}

/** Parses the UA sheet (origin ua) followed by `sources`, chaining `Rule.order`. Cacheable per source set. */
export function parseSheets(sources: readonly SheetSource[]): ParsedSheet[] {
    return runParse(sources);
}

// ---------------------------------------------------------------- conventions (implemented)

/** The canvas default: text in the canvas role's fg; transparent background. */
const CANVAS_FG: Color = { group: "HtmlViewHostCanvas", attr: "fg" };
const TRANSPARENT: Color = { hex: "#000000", alpha: 0 };
const NO_BORDER: BorderSide = { style: "none", width: 0, color: CANVAS_FG };

/** CSS initial values (display `inline` as in CSS; the UA sheet makes blocks blocks). */
export function initialStyle(): ComputedStyle {
    return {
        display: "inline",
        visibility: "visible",
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
        padding: { top: 0, right: 0, bottom: 0, left: 0 },
        border: { top: NO_BORDER, right: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER },
        color: CANVAS_FG,
        backgroundColor: TRANSPARENT,
        fontWeight: 400,
        fontStyle: "normal",
        textDecoration: { underline: false, lineThrough: false, overline: false },
        whiteSpace: "normal",
        tabSize: 0,
        textAlign: "left",
        textTransform: "none",
        listStyleType: "disc",
        listStylePosition: "outside",
        order: 0,
        fill: false,
        content: undefined,
        counterReset: [],
        counterIncrement: [],
        counterSet: [],
        custom: {},
    };
}

/**
 * Inherited properties (CSS): the rest reset to initial on each element. `textDecoration` is NOT inherited but
 * PROPAGATES to descendants' text in a browser; layout realises that through paint nesting (the decorating
 * element's mark covers its descendants), not by inheritance.
 */
export const inheritedProperties: ReadonlySet<keyof ComputedStyle> = new Set<keyof ComputedStyle>([
    "visibility",
    "color",
    "fontWeight",
    "fontStyle",
    "whiteSpace",
    "tabSize",
    "textAlign",
    "textTransform",
    "listStyleType",
    "listStylePosition",
    "custom",
]);

/**
 * CSS length → cells (horizontal) or lines (vertical), rounded half up, never negative for padding/border:
 * `ch` 1 cell; `em`/`rem` 1 cell horizontally and 1 line vertically; `px` /8 horizontally, /16 vertically;
 * `pt` as px × 4/3; `%` of `containerCells` horizontally, 0 vertically; unitless `0` 0. `NaN` for anything else
 * (the declaration is then invalid and dropped).
 */
export function lengthToCells(value: number, unit: string, axis: "h" | "v", containerCells: number): number {
    const u: string = unit.toLowerCase();
    const perCell: Record<string, number> = { ch: 1, em: 1, rem: 1, px: axis === "h" ? 8 : 16, pt: axis === "h" ? 6 : 12 };
    let cells: number;
    if (u === "%") {
        cells = axis === "h" ? (value * containerCells) / 100 : 0;
    } else if (u === "" && value === 0) {
        cells = 0;
    } else if (u in perCell) {
        cells = value / perCell[u];
    } else {
        cells = NaN;
    }
    return Number.isNaN(cells) ? NaN : Math.sign(cells) * Math.floor(Math.abs(cells) + 0.5);
}

/**
 * The naming rule (today's `style/groupName`, unchanged): `HtmlView` + PascalCase of the `[A-Za-z0-9]` runs.
 * `.impact-high` → `HtmlViewImpactHigh`, `--vscode-textLink-foreground` → `HtmlViewVscodeTextLinkForeground`,
 * `.other-context-list .do::before` → `HtmlViewOtherContextListDoBefore`.
 */
export function groupName(selectorOrVar: string): string {
    const words: string[] = selectorOrVar.match(/[A-Za-z0-9]+/g) || [];
    return "HtmlView" + words.map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

/**
 * The engine's layout hints, set by the UA sheet as custom properties (CSS-driven, never tag checks). Unlike other
 * custom properties they are NOT inherited (as if registered with `@property { inherits: false }`): a hint is in
 * `ComputedStyle.custom` only on the element a rule sets it on, so a `span` inside `h2` is no heading.
 * Author and user sheets may set or unset them (`--htmlview-code: none`) like any property.
 */
export const LayoutHint = {
    /** `block` on the element whose content is a code block (`pre`); layout emits a CodeRegion for it. */
    code: "--htmlview-code",
    /** Heading level `1`–`6` (`h1`–`h6`): layout emits an Anchor with `level`, for folds and the outline. */
    heading: "--htmlview-heading",
    /** `href`: layout emits Links for the element's `href` attribute (`a[href]`). */
    link: "--htmlview-link",
    /** `alt`: replaced element, rendered as its `alt` attribute (`img`). */
    replaced: "--htmlview-replaced",
    /** `label` (`label[for]`) or `control` (radio/checkbox): activation toggles a control, see interact/. */
    toggle: "--htmlview-toggle",
    /** `line` (`br`): forced line break; `opportunity` (`wbr`): a break opportunity. */
    break: "--htmlview-break",
} as const;
