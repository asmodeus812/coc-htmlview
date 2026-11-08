/**
 * The property layer of the style part (private to style/): which longhands exist, how shorthands expand into
 * them, and how one longhand value parses into a context-free typed value (context — the parent style,
 * `currentcolor`, `bolder` — is applied by compute.ts). Unknown properties expand to nothing (ignored, as a
 * browser ignores what it does not render); malformed values return `undefined` (the declaration is dropped).
 */
import type { AlignItems, BorderStyle, ContentItem, CounterOp, Display, ListStylePosition, ListStyleType, TextAlign, Visibility, WhiteSpace } from "./index";
import { lengthToCells } from "./index";
import type { HostVarTable } from "./host";
import type { Length, ParsedColor } from "./values";
import { parseColor, parseContent, parseCounterOps, parseLength, parseListStyleType, tokens, wideKeyword } from "./values";

export const SIDES: readonly ["top", "right", "bottom", "left"] = ["top", "right", "bottom", "left"];
export type Side = (typeof SIDES)[number];

/** Every longhand the engine computes. */
const LONGHANDS: readonly string[] = [
    "color",
    "display",
    "visibility",
    ...SIDES.map((s: Side) => `margin-${s}`),
    ...SIDES.map((s: Side) => `padding-${s}`),
    ...SIDES.flatMap((s: Side) => [`border-${s}-width`, `border-${s}-style`, `border-${s}-color`]),
    "background-color",
    "font-weight",
    "font-style",
    "text-decoration-line",
    "text-decoration-color",
    "white-space",
    "tab-size",
    "text-align",
    "text-transform",
    "list-style-type",
    "list-style-position",
    "content",
    "counter-reset",
    "counter-increment",
    "counter-set",
    "flex-direction",
    "order",
    "width",
    "align-items",
];

const LONGHAND_SET: ReadonlySet<string> = new Set<string>(LONGHANDS);

/** Longhands that inherit (CSS); the others reset to their initial value on each element. */
export const INHERITED: ReadonlySet<string> = new Set<string>([
    "color",
    "visibility",
    "font-weight",
    "font-style",
    "white-space",
    "tab-size",
    "text-align",
    "text-transform",
    "list-style-type",
    "list-style-position",
]);

/** The longhands a shorthand sets (also the targets of a CSS-wide keyword on it). */
const SHORTHANDS: Readonly<Record<string, readonly string[]>> = {
    margin: SIDES.map((s: Side) => `margin-${s}`),
    padding: SIDES.map((s: Side) => `padding-${s}`),
    border: SIDES.flatMap((s: Side) => [`border-${s}-width`, `border-${s}-style`, `border-${s}-color`]),
    "border-width": SIDES.map((s: Side) => `border-${s}-width`),
    "border-style": SIDES.map((s: Side) => `border-${s}-style`),
    "border-color": SIDES.map((s: Side) => `border-${s}-color`),
    "border-top": ["border-top-width", "border-top-style", "border-top-color"],
    "border-right": ["border-right-width", "border-right-style", "border-right-color"],
    "border-bottom": ["border-bottom-width", "border-bottom-style", "border-bottom-color"],
    "border-left": ["border-left-width", "border-left-style", "border-left-color"],
    "margin-block": ["margin-top", "margin-bottom"],
    "margin-inline": ["margin-left", "margin-right"],
    "padding-block": ["padding-top", "padding-bottom"],
    "padding-inline": ["padding-left", "padding-right"],
    background: ["background-color"],
    "list-style": ["list-style-type", "list-style-position"],
    "text-decoration": ["text-decoration-line", "text-decoration-color"],
    font: ["font-weight", "font-style"],
    "flex-flow": ["flex-direction"],
};

/** Logical longhands mapped onto physical ones (horizontal-tb, ltr: the only writing mode here). */
const LOGICAL: Readonly<Record<string, string>> = {
    "margin-block-start": "margin-top",
    "margin-block-end": "margin-bottom",
    "margin-inline-start": "margin-left",
    "margin-inline-end": "margin-right",
    "padding-block-start": "padding-top",
    "padding-block-end": "padding-bottom",
    "padding-inline-start": "padding-left",
    "padding-inline-end": "padding-right",
    "border-block-start": "border-top",
    "border-block-end": "border-bottom",
    "border-inline-start": "border-left",
    "border-inline-end": "border-right",
};

const BORDER_STYLES: ReadonlyMap<string, BorderStyle> = new Map<string, BorderStyle>([
    ["none", "none"],
    ["hidden", "none"],
    ["solid", "solid"],
    ["dashed", "dashed"],
    ["dotted", "dotted"],
    ["double", "double"],
    ["groove", "solid"],
    ["ridge", "solid"],
    ["inset", "solid"],
    ["outset", "solid"],
]);

/** 1–4 values to the four sides (`a` → all; `a b` → v h; `a b c` → t h b; `a b c d`). */
function fourSides(vals: string[]): string[] | undefined {
    const n: number = vals.length;
    let out: string[] | undefined;
    if (n === 1) {
        out = [vals[0], vals[0], vals[0], vals[0]];
    } else if (n === 2) {
        out = [vals[0], vals[1], vals[0], vals[1]];
    } else if (n === 3) {
        out = [vals[0], vals[1], vals[2], vals[1]];
    } else if (n === 4) {
        out = vals.slice();
    }
    return out;
}

function isBorderWidth(t: string): boolean {
    return /^(thin|medium|thick)$/i.test(t) || parseLength(t) !== undefined;
}

function isColor(t: string, hostVars: HostVarTable): boolean {
    return parseColor(t, hostVars) !== undefined;
}

/** `border`-style shorthand tokens → [width, style, color]; missing parts are their initial values. */
function borderParts(value: string, hostVars: HostVarTable): string[] | undefined {
    let width: string | undefined;
    let style: string | undefined;
    let color: string | undefined;
    let ok: boolean = true;
    for (const t of tokens(value)) {
        if (width === undefined && isBorderWidth(t)) {
            width = t;
        } else if (style === undefined && BORDER_STYLES.has(t.toLowerCase())) {
            style = t;
        } else if (color === undefined && isColor(t, hostVars)) {
            color = t;
        } else {
            ok = false;
        }
    }
    return ok ? [width || "medium", style || "none", color || "currentcolor"] : undefined;
}

function expandList(value: string): Array<[string, string]> | undefined {
    let type: string | undefined;
    let position: string | undefined;
    let nones: number = 0;
    let ok: boolean = true;
    for (const t of tokens(value)) {
        const lower: string = t.toLowerCase();
        if (lower === "none") {
            nones += 1;
        } else if (position === undefined && (lower === "inside" || lower === "outside")) {
            position = lower;
        } else if (type === undefined && parseListStyleType(t) !== undefined) {
            type = t;
        } else if (/^url\(/i.test(t)) {
            ok = ok && true;
        } else {
            ok = false;
        }
    }
    const finalType: string = type !== undefined ? type : nones > 0 ? "none" : "disc";
    return ok ? [["list-style-type", finalType], ["list-style-position", position || "outside"]] : undefined;
}

function expandTextDecoration(value: string, hostVars: HostVarTable): Array<[string, string]> | undefined {
    const lines: string[] = [];
    let color: string | undefined;
    let ok: boolean = true;
    for (const t of tokens(value)) {
        const lower: string = t.toLowerCase();
        if (/^(underline|overline|line-through|blink|none)$/.test(lower)) {
            lines.push(lower);
        } else if (/^(solid|double|dotted|dashed|wavy|auto|from-font)$/.test(lower) || parseLength(t) !== undefined) {
            ok = ok && true;
        } else if (color === undefined && isColor(t, hostVars)) {
            color = t;
        } else {
            ok = false;
        }
    }
    return ok ? [["text-decoration-line", lines.length > 0 ? lines.join(" ") : "none"], ["text-decoration-color", color || "currentcolor"]] : undefined;
}

function expandFont(value: string): Array<[string, string]> | undefined {
    let weight: string = "normal";
    let style: string = "normal";
    const sysFont: boolean = /^(caption|icon|menu|message-box|small-caption|status-bar)$/i.test(value.trim());
    for (const t of tokens(value)) {
        const lower: string = t.toLowerCase();
        if (lower === "italic" || lower === "oblique") {
            style = "italic";
        } else if (/^(bold|bolder|lighter|[1-9]00)$/.test(lower)) {
            weight = lower;
        }
    }
    return sysFont ? [["font-weight", "normal"], ["font-style", "normal"]] : [["font-weight", weight], ["font-style", style]];
}

function expandBackground(value: string, hostVars: HostVarTable): Array<[string, string]> {
    const layers: string = value.split(",").pop() || "";
    const color: string | undefined = isColor(value, hostVars) ? value : tokens(layers).find((t: string) => isColor(t, hostVars));
    return [["background-color", color || "transparent"]];
}

/**
 * Expands one declaration into longhand `[name, value]` pairs. A CSS-wide keyword reaches every longhand of a
 * shorthand. `undefined` = malformed (drop); `[]` = a property the engine does not compute.
 */
export function expandDeclaration(property: string, value: string, hostVars: HostVarTable): Array<[string, string]> | undefined {
    const prop: string = LOGICAL[property] || property;
    const kw: string | undefined = wideKeyword(value);
    const vals: string[] = tokens(value);
    const sides: string[] | undefined = fourSides(vals);
    const twoSides: string[] = vals.length === 1 ? [vals[0], vals[0]] : vals;
    let out: Array<[string, string]> | undefined;
    if (kw !== undefined && SHORTHANDS[prop] !== undefined) {
        out = SHORTHANDS[prop].map((l: string): [string, string] => [l, kw]);
    } else if (LONGHAND_SET.has(prop)) {
        out = kw !== undefined || parseValue(prop, value, hostVars) !== undefined ? [[prop, value]] : undefined;
    } else if (prop === "margin" || prop === "padding" || prop === "border-width" || prop === "border-style" || prop === "border-color") {
        const names: readonly string[] = SHORTHANDS[prop];
        const pairs: Array<[string, string]> | undefined = sides ? names.map((l: string, i: number): [string, string] => [l, sides[i]]) : undefined;
        out = pairs && pairs.every(([l, v]: [string, string]) => parseValue(l, v, hostVars) !== undefined) ? pairs : undefined;
    } else if (/^(margin|padding)-(block|inline)$/.test(prop)) {
        const names: readonly string[] = SHORTHANDS[prop];
        const pairs: Array<[string, string]> | undefined = twoSides.length === 2 ? names.map((l: string, i: number): [string, string] => [l, twoSides[i]]) : undefined;
        out = pairs && pairs.every(([l, v]: [string, string]) => parseValue(l, v, hostVars) !== undefined) ? pairs : undefined;
    } else if (prop === "border" || /^border-(top|right|bottom|left)$/.test(prop)) {
        const parts: string[] | undefined = borderParts(value, hostVars);
        const names: readonly string[] = SHORTHANDS[prop];
        out = parts ? names.map((l: string, i: number): [string, string] => [l, parts[i % 3]]) : undefined;
    } else if (prop === "background") {
        out = expandBackground(value, hostVars);
    } else if (prop === "list-style") {
        out = expandList(value);
    } else if (prop === "text-decoration") {
        out = expandTextDecoration(value, hostVars);
    } else if (prop === "font") {
        out = expandFont(value);
    } else if (prop === "flex-flow") {
        const dir: string | undefined = vals.find((t: string) => /^(row|row-reverse|column|column-reverse)$/i.test(t));
        out = [["flex-direction", dir || "row"]];
    } else {
        out = [];
    }
    return out;
}

// ---------------------------------------------------------------- longhand values

/** A `display` value: the engine's {@link Display} plus the raw keyword (for blockification and flex items). */
export interface DisplayValue {
    raw: string;
    display: Display;
}

const DISPLAY_RAW: Readonly<Record<string, string>> = {
    "block flow": "block",
    "inline flow": "inline",
    "inline flow-root": "inline-block",
    "block flex": "flex",
    "inline flex": "inline-flex",
    "block grid": "grid",
    "inline grid": "inline-grid",
    "block table": "table",
    "inline table": "inline-table",
    "block list-item": "list-item",
    "list-item block": "list-item",
    "block flow list-item": "list-item",
    "-webkit-box": "flex",
    "-webkit-inline-box": "inline-flex",
};

const DISPLAY_OF: Readonly<Record<string, Display>> = {
    none: "none",
    block: "block",
    "flow-root": "block",
    "run-in": "block",
    grid: "block",
    "inline-grid": "inline-block",
    inline: "inline",
    ruby: "inline",
    "ruby-base": "inline",
    "ruby-text": "inline",
    "inline-block": "inline-block",
    "list-item": "list-item",
    table: "table",
    "inline-table": "table",
    "table-caption": "table-caption",
    "table-header-group": "table-header-group",
    "table-row-group": "table-row-group",
    "table-footer-group": "table-footer-group",
    "table-row": "table-row",
    "table-cell": "table-cell",
    "table-column": "none",
    "table-column-group": "none",
    flex: "flex",
    "inline-flex": "flex",
    contents: "contents",
};

/** A raw display keyword (Firefox's computed form included) → the engine's {@link Display}; undefined if unknown. */
export function displayOf(raw: string): Display | undefined {
    const norm: string = raw.trim().toLowerCase().replace(/\s+/g, " ");
    return DISPLAY_OF[DISPLAY_RAW[norm] || norm];
}

/** CSS Display 3 blockification (flex/grid items, the root): the raw keyword's block-level equivalent. */
export function blockify(raw: string): string {
    const map: Readonly<Record<string, string>> = {
        inline: "block",
        "inline-block": "block",
        "inline-flex": "flex",
        "inline-grid": "grid",
        "inline-table": "table",
        ruby: "block",
        "ruby-base": "block",
        "ruby-text": "block",
        "table-caption": "block",
        "table-header-group": "block",
        "table-row-group": "block",
        "table-footer-group": "block",
        "table-row": "block",
        "table-cell": "block",
    };
    return map[raw] || raw;
}

/** `text-decoration-line` flags. */
export interface DecorationLine {
    underline: boolean;
    lineThrough: boolean;
    overline: boolean;
}

/** A typed longhand value, before context (`currentcolor`, `bolder`) is applied. */
export type ParsedValue =
    | number
    | string
    | DisplayValue
    | ParsedColor
    | DecorationLine
    | ListStyleType
    | ContentItem[]
    | CounterOp[]
    | null;

function parseMargin(value: string, axis: "h" | "v"): number | undefined {
    const len: Length | undefined = parseLength(value);
    const cells: number = len ? lengthToCells(len.value, len.unit, axis, 0) : NaN;
    return value.trim().toLowerCase() === "auto" ? 0 : Number.isNaN(cells) ? undefined : cells + 0;
}

function parsePadding(value: string, axis: "h" | "v"): number | undefined {
    const len: Length | undefined = parseLength(value);
    const cells: number = len && len.value >= 0 ? lengthToCells(len.value, len.unit, axis, 0) : NaN;
    return Number.isNaN(cells) ? undefined : cells + 0;
}

function parseBorderWidth(value: string): number | undefined {
    const len: Length | undefined = parseLength(value);
    const lower: string = value.trim().toLowerCase();
    let w: number | undefined;
    if (/^(thin|medium|thick)$/.test(lower)) {
        w = 1;
    } else if (len !== undefined && len.value >= 0 && (len.unit === "" || /^(px|em|rem|ch|pt)$/.test(len.unit))) {
        w = len.value > 0 ? 1 : 0;
    }
    return w;
}

function parseWeight(value: string): number | string | undefined {
    const lower: string = value.trim().toLowerCase();
    const n: number = /^\d+(\.\d+)?$/.test(lower) ? parseFloat(lower) : NaN;
    let w: number | string | undefined;
    if (lower === "normal") {
        w = 400;
    } else if (lower === "bold") {
        w = 700;
    } else if (lower === "bolder" || lower === "lighter") {
        w = lower;
    } else if (!isNaN(n) && n >= 1 && n <= 1000) {
        w = n;
    }
    return w;
}

function parseDecorationLine(value: string): DecorationLine | undefined {
    const toks: string[] = tokens(value.toLowerCase());
    const known: boolean = toks.length > 0 && toks.every((t: string) => /^(underline|overline|line-through|blink|none|spelling-error|grammar-error)$/.test(t));
    const none: boolean = toks.length === 1 && toks[0] === "none";
    return known && (none || !toks.includes("none"))
        ? { underline: toks.includes("underline"), lineThrough: toks.includes("line-through"), overline: toks.includes("overline") }
        : undefined;
}

function keyword<T extends string>(value: string, allowed: readonly T[], aliases: Readonly<Record<string, T>> = {}): T | undefined {
    const lower: string = value.trim().toLowerCase();
    const direct: T | undefined = (allowed as readonly string[]).includes(lower) ? (lower as T) : undefined;
    return direct !== undefined ? direct : aliases[lower];
}

/**
 * Parses one longhand value (CSS-wide keywords are handled by the caller). Lengths are already cells/lines.
 */
export function parseValue(longhand: string, value: string, hostVars: HostVarTable): ParsedValue | undefined {
    const side: RegExpMatchArray | null = longhand.match(/^(margin|padding|border)-(top|right|bottom|left)(?:-(width|style|color))?$/);
    const axis: "h" | "v" = side && (side[2] === "left" || side[2] === "right") ? "h" : "v";
    let out: ParsedValue | undefined;
    if (side && side[1] === "margin") {
        out = parseMargin(value, axis);
    } else if (side && side[1] === "padding") {
        out = parsePadding(value, axis);
    } else if (side && side[3] === "width") {
        out = parseBorderWidth(value);
    } else if (side && side[3] === "style") {
        out = BORDER_STYLES.get(value.trim().toLowerCase());
    } else if (longhand === "color" || longhand === "background-color" || (side && side[3] === "color") || longhand === "text-decoration-color") {
        out = parseColor(value, hostVars);
    } else if (longhand === "display") {
        const raw: string = value.trim().toLowerCase().replace(/\s+/g, " ");
        const display: Display | undefined = displayOf(raw);
        out = display !== undefined ? { raw: DISPLAY_RAW[raw] || raw, display } : undefined;
    } else if (longhand === "visibility") {
        out = keyword<Visibility>(value, ["visible", "hidden", "collapse"]);
    } else if (longhand === "font-weight") {
        out = parseWeight(value);
    } else if (longhand === "font-style") {
        out = keyword<"normal" | "italic">(value, ["normal", "italic"], { oblique: "italic" }) || (/^oblique\s/i.test(value.trim()) ? "italic" : undefined);
    } else if (longhand === "text-decoration-line") {
        out = parseDecorationLine(value);
    } else if (longhand === "white-space") {
        out = keyword<WhiteSpace>(value, ["normal", "nowrap", "pre", "pre-wrap", "pre-line"], { "break-spaces": "pre-wrap", "-moz-pre-space": "pre-wrap" });
    } else if (longhand === "tab-size") {
        out = /^[+]?\d+$/.test(value.trim()) && Number(value.trim()) > 0 ? Number(value.trim()) : undefined;
    } else if (longhand === "text-align") {
        out = keyword<TextAlign>(value, ["left", "right", "center", "justify"], {
            start: "left",
            end: "right",
            "-webkit-center": "center",
            "-moz-center": "center",
            "-webkit-left": "left",
            "-moz-left": "left",
            "-webkit-right": "right",
            "-moz-right": "right",
            "match-parent": "left",
        });
    } else if (longhand === "text-transform") {
        out = keyword<"none" | "uppercase" | "lowercase" | "capitalize">(value, ["none", "uppercase", "lowercase", "capitalize"]);
    } else if (longhand === "list-style-type") {
        out = parseListStyleType(value);
    } else if (longhand === "list-style-position") {
        out = keyword<ListStylePosition>(value, ["outside", "inside"]);
    } else if (longhand === "content") {
        out = parseContent(value);
    } else if (longhand === "counter-reset" || longhand === "counter-set") {
        out = parseCounterOps(value, 0);
    } else if (longhand === "counter-increment") {
        out = parseCounterOps(value, 1);
    } else if (longhand === "flex-direction") {
        out = keyword<string>(value, ["row", "row-reverse", "column", "column-reverse"]);
    } else if (longhand === "align-items") {
        // only the cross-axis position of a row item matters to a cell grid: top, middle or bottom
        out = keyword<AlignItems>(value, ["normal", "stretch", "start", "center", "end"], {
            "flex-start": "start",
            "self-start": "start",
            baseline: "start",
            "first baseline": "start",
            "flex-end": "end",
            "self-end": "end",
        });
    } else if (longhand === "order") {
        out = /^[+-]?\d+$/.test(value.trim()) ? Number(value.trim()) : undefined;
    } else if (longhand === "width") {
        // only a full-row width matters to a cell grid (a flex item that takes its own row)
        out = /^100(\.0+)?%$/.test(value.trim()) ? "fill" : /^(auto|[+]?[\d.]+(%|[a-z]+)?)$/i.test(value.trim()) ? "auto" : undefined;
    }
    return out;
}
