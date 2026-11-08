/**
 * Value-level helpers of the style part (private to style/): top-level token splitting, `var()` substitution,
 * colours, lengths, `content`, counters and list-style types. Pure; nothing here throws on bad input: a parser
 * returns `undefined` and the caller drops (or unsets) the declaration.
 */
import type { Color, ContentItem, CounterOp, ListStyleType } from "./index";
import type { HostVarTable } from "./host";

const MAX_DEPTH: number = 24;

// ---------------------------------------------------------------- tokens

/** Splits `value` on top-level separators (whitespace or commas), keeping parentheses and quotes together. */
function splitTop(value: string, sep: "space" | "comma"): string[] {
    const out: string[] = [];
    let depth: number = 0;
    let quote: string = "";
    let current: string = "";
    let escaped: boolean = false;
    for (const ch of value.trim()) {
        const inQuote: boolean = quote.length > 0;
        const isSep: boolean = !inQuote && depth === 0 && !escaped && (sep === "space" ? /\s/.test(ch) : ch === ",");
        if (escaped) {
            escaped = false;
        } else if (ch === "\\") {
            escaped = true;
        } else if (inQuote && ch === quote) {
            quote = "";
        } else if (!inQuote && (ch === '"' || ch === "'")) {
            quote = ch;
        } else if (!inQuote && ch === "(") {
            depth += 1;
        } else if (!inQuote && ch === ")") {
            depth = Math.max(0, depth - 1);
        }
        if (isSep) {
            out.push(current);
            current = "";
        } else {
            current += ch;
        }
    }
    out.push(current);
    return out.map((t: string) => t.trim()).filter((t: string) => sep === "comma" || t.length > 0);
}

/** Space-separated tokens, empty ones dropped. */
export function tokens(value: string): string[] {
    return splitTop(value, "space").filter((t: string) => t.length > 0);
}

/** The CSS-wide keywords every property accepts. */
export type WideKeyword = "inherit" | "initial" | "unset";

/** `inherit` / `initial` / `unset` (`revert` and `revert-layer` behave as `unset` here), else undefined. */
export function wideKeyword(value: string): WideKeyword | undefined {
    const v: string = value.trim().toLowerCase();
    let kw: WideKeyword | undefined;
    if (v === "inherit" || v === "initial" || v === "unset") {
        kw = v;
    } else if (v === "revert" || v === "revert-layer") {
        kw = "unset";
    }
    return kw;
}

// ---------------------------------------------------------------- var()

/** Looks a custom property up in the element's scope (undefined: not defined / guaranteed-invalid). */
export type CustomLookup = (name: string) => string | undefined;

/** Finds the matching `)` of the `(` at `open`; -1 when unbalanced. */
function closeParen(text: string, open: number): number {
    let depth: number = 0;
    let found: number = -1;
    for (let i: number = open; i < text.length && found < 0; i++) {
        const ch: string = text.charAt(i);
        depth += ch === "(" ? 1 : ch === ")" ? -1 : 0;
        found = depth === 0 && ch === ")" ? i : -1;
    }
    return found;
}

/** Whether a value references any `var()`. */
export function hasVar(value: string): boolean {
    return /var\(/i.test(value);
}

/**
 * Substitutes every `var(--name[, fallback])` in `value`: a custom property in scope gives its value; a host
 * variable of `hostVars` that the document does not define stays as `var(--name)` (the colorscheme fills it, see
 * {@link parseColor}); otherwise the fallback, else the whole value is invalid (`undefined`).
 */
export function substitute(value: string, lookup: CustomLookup, hostVars: HostVarTable, depth: number = 0): string | undefined {
    const at: number = value.search(/var\(/i);
    let result: string | undefined;
    if (depth > MAX_DEPTH) {
        result = undefined;
    } else if (at < 0) {
        result = value;
    } else {
        const close: number = closeParen(value, at + 3);
        const inner: string = close > 0 ? value.slice(at + 4, close) : "";
        const m: RegExpMatchArray | null = inner.match(/^\s*(--[A-Za-z0-9_-]+)\s*(?:,([\s\S]*))?$/);
        const name: string = m ? m[1] : "";
        const fallback: string | undefined = m && m[2] !== undefined ? m[2].trim() : undefined;
        const own: string | undefined = m ? lookup(name) : undefined;
        let piece: string | undefined;
        if (!m || close < 0) {
            piece = undefined;
        } else if (own !== undefined) {
            piece = own;
        } else if (hostVars[name] !== undefined) {
            piece = `var(${name})`;
        } else if (fallback !== undefined) {
            piece = substitute(fallback, lookup, hostVars, depth + 1);
        } else {
            piece = undefined;
        }
        const rest: string | undefined = piece !== undefined ? substitute(value.slice(close + 1), lookup, hostVars, depth + 1) : undefined;
        result = piece !== undefined && rest !== undefined ? value.slice(0, at) + piece + rest : undefined;
    }
    return result;
}

/**
 * Computes the custom properties of an element: `declared` (cascade winners, raw) substituted against each other
 * and the inherited scope `inherited`; cycles and unresolvable references make a property guaranteed-invalid
 * (absent). `inherit`/`unset` keep the inherited value, `initial` removes it.
 */
export function resolveCustom(declared: ReadonlyMap<string, string>, inherited: Readonly<Record<string, string>>, hostVars: HostVarTable): Record<string, string> {
    const out: Record<string, string> = { ...inherited };
    const done: Map<string, string | undefined> = new Map<string, string | undefined>();
    const visiting: Set<string> = new Set<string>();
    const resolve = (name: string): string | undefined => {
        const raw: string = declared.get(name) || "";
        const kw: WideKeyword | undefined = wideKeyword(raw);
        let value: string | undefined;
        if (done.has(name)) {
            value = done.get(name);
        } else if (visiting.has(name)) {
            value = undefined;
        } else if (kw === "initial") {
            value = undefined;
        } else if (kw !== undefined) {
            value = inherited[name];
        } else {
            visiting.add(name);
            value = substitute(raw, (n: string) => (declared.has(n) ? resolve(n) : inherited[n]), hostVars);
            visiting.delete(name);
        }
        done.set(name, value);
        return value;
    };
    for (const name of declared.keys()) {
        const value: string | undefined = resolve(name);
        if (value === undefined) {
            delete out[name];
        } else {
            out[name] = value.trim();
        }
    }
    return out;
}

// ---------------------------------------------------------------- colours

const NAMED_TEXT: string =
    "black:000000 white:ffffff red:ff0000 green:008000 blue:0000ff yellow:ffff00 orange:ffa500 gray:808080 " +
    "grey:808080 silver:c0c0c0 maroon:800000 purple:800080 fuchsia:ff00ff magenta:ff00ff lime:00ff00 olive:808000 " +
    "navy:000080 teal:008080 aqua:00ffff cyan:00ffff pink:ffc0cb brown:a52a2a gold:ffd700 indigo:4b0082 " +
    "violet:ee82ee darkred:8b0000 darkgreen:006400 darkblue:00008b lightgray:d3d3d3 lightgrey:d3d3d3 " +
    "darkgray:a9a9a9 darkgrey:a9a9a9 dimgray:696969 dimgrey:696969 crimson:dc143c tomato:ff6347 coral:ff7f50 " +
    "salmon:fa8072 khaki:f0e68c beige:f5f5dc ivory:fffff0 whitesmoke:f5f5f5 gainsboro:dcdcdc slategray:708090 " +
    "steelblue:4682b4 royalblue:4169e1 dodgerblue:1e90ff skyblue:87ceeb orchid:da70d6 plum:dda0dd tan:d2b48c " +
    "chocolate:d2691e firebrick:b22222 seagreen:2e8b57 forestgreen:228b22 limegreen:32cd32 darkorange:ff8c00 " +
    "orangered:ff4500 hotpink:ff69b4 deeppink:ff1493 rebeccapurple:663399 lightblue:add8e6 lightgreen:90ee90 " +
    "lightyellow:ffffe0 darkcyan:008b8b darkmagenta:8b008b goldenrod:daa520 sienna:a0522d wheat:f5deb3 " +
    "linen:faf0e6 lavender:e6e6fa turquoise:40e0d0 mediumblue:0000cd midnightblue:191970 darkviolet:9400d3";

const NAMED: ReadonlyMap<string, string> = new Map<string, string>(
    NAMED_TEXT.split(" ").map((pair: string): [string, string] => [pair.split(":")[0], "#" + pair.split(":")[1]]),
);

function hex2(n: number): string {
    return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
}

function clampAlpha(a: number): number {
    return Math.max(0, Math.min(1, a));
}

function parseHex(value: string): Color | undefined {
    const m: RegExpMatchArray | null = value.match(/^#([0-9a-f]{3,8})$/i);
    const digits: string = m ? m[1].toLowerCase() : "";
    const short: boolean = digits.length === 3 || digits.length === 4;
    const full: string = short ? digits.split("").map((d: string) => d + d).join("") : digits;
    const valid: boolean = full.length === 6 || full.length === 8;
    const alpha: number = full.length === 8 ? parseInt(full.slice(6), 16) / 255 : 1;
    return valid ? { hex: "#" + full.slice(0, 6), alpha: Math.round(alpha * 1000) / 1000 } : undefined;
}

function numberArgs(inner: string): string[] {
    return inner.split(/[\s,/]+/).filter((t: string) => t.length > 0);
}

function alphaOf(t: string | undefined): number {
    return t === undefined ? 1 : t.endsWith("%") ? parseFloat(t) / 100 : parseFloat(t);
}

function parseRgb(value: string): Color | undefined {
    const m: RegExpMatchArray | null = value.match(/^rgba?\(([^)]*)\)$/i);
    const nums: string[] = m ? numberArgs(m[1]) : [];
    const channel = (t: string): number => (t.endsWith("%") ? (parseFloat(t) * 255) / 100 : parseFloat(t));
    const rgb: number[] = nums.slice(0, 3).map(channel);
    const alpha: number = alphaOf(nums[3]);
    const valid: boolean = (nums.length === 3 || nums.length === 4) && rgb.every((n: number) => !isNaN(n)) && !isNaN(alpha);
    return valid ? { hex: "#" + rgb.map(hex2).join(""), alpha: clampAlpha(alpha) } : undefined;
}

function hueToRgb(p: number, q: number, t0: number): number {
    const t: number = t0 < 0 ? t0 + 1 : t0 > 1 ? t0 - 1 : t0;
    let v: number;
    if (t < 1 / 6) {
        v = p + (q - p) * 6 * t;
    } else if (t < 1 / 2) {
        v = q;
    } else if (t < 2 / 3) {
        v = p + (q - p) * (2 / 3 - t) * 6;
    } else {
        v = p;
    }
    return v;
}

function parseHsl(value: string): Color | undefined {
    const m: RegExpMatchArray | null = value.match(/^hsla?\(([^)]*)\)$/i);
    const nums: string[] = m ? numberArgs(m[1]) : [];
    const h: number = (((parseFloat(nums[0] || "") % 360) + 360) % 360) / 360;
    const s: number = parseFloat(nums[1] || "") / 100;
    const l: number = parseFloat(nums[2] || "") / 100;
    const alpha: number = alphaOf(nums[3]);
    const valid: boolean = (nums.length === 3 || nums.length === 4) && ![h, s, l, alpha].some((n: number) => isNaN(n));
    const q: number = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p: number = 2 * l - q;
    const rgb: number[] = [h + 1 / 3, h, h - 1 / 3].map((t: number) => hueToRgb(p, q, t) * 255);
    return valid ? { hex: "#" + rgb.map(hex2).join(""), alpha: clampAlpha(alpha) } : undefined;
}

/** A parsed colour value: a computed {@link Color}, or `currentcolor` (resolved by the caller). */
export type ParsedColor = Color | "currentcolor";

/**
 * Parses a whole colour value (after var() substitution): hex, `rgb[a]()`, `hsl[a]()`, named, `transparent`,
 * `currentcolor`, or `var(--host)` (a host variable kept by {@link substitute}) → `{var, attr}`.
 */
export function parseColor(value: string, hostVars: HostVarTable): ParsedColor | undefined {
    const v: string = value.trim();
    const lower: string = v.toLowerCase();
    const varMatch: RegExpMatchArray | null = v.match(/^var\(\s*(--[A-Za-z0-9_-]+)\s*\)$/);
    const named: string | undefined = NAMED.get(lower);
    let color: ParsedColor | undefined;
    if (varMatch && hostVars[varMatch[1]] !== undefined) {
        color = { var: varMatch[1], attr: hostVars[varMatch[1]].attr };
    } else if (lower === "currentcolor") {
        color = "currentcolor";
    } else if (lower === "transparent") {
        color = { hex: "#000000", alpha: 0 };
    } else if (v.startsWith("#")) {
        color = parseHex(v);
    } else if (/^rgba?\(/i.test(v)) {
        color = parseRgb(v);
    } else if (/^hsla?\(/i.test(v)) {
        color = parseHsl(v);
    } else if (named !== undefined) {
        color = { hex: named, alpha: 1 };
    }
    return color;
}

// ---------------------------------------------------------------- lengths

/** A CSS length token: number and unit (`""` for a unitless number). */
export interface Length {
    value: number;
    unit: string;
}

/** Parses `12px`, `1.5em`, `-1rem`, `0`, `50%`; undefined for anything else (`auto`, `calc()`, …). */
export function parseLength(token: string): Length | undefined {
    const m: RegExpMatchArray | null = token.trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)$/i);
    const value: number = m ? parseFloat(m[1]) : NaN;
    const unit: string = m ? m[2].toLowerCase() : "";
    const ok: boolean = m !== null && !isNaN(value) && (unit !== "" || value === 0);
    return ok ? { value, unit } : undefined;
}

// ---------------------------------------------------------------- content, counters, list styles

/** Decodes a quoted CSS string (`"\2713"`, `'it\'s'`); undefined when `token` is not a string. */
export function cssString(token: string): string | undefined {
    const m: RegExpMatchArray | null = token.match(/^(["'])([\s\S]*)\1$/);
    const decode = (s: string): string =>
        s.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(\n)|\\([\s\S])/g, (_all: string, hex: string, nl: string, ch: string) =>
            hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff) || 0xfffd) : nl ? "" : ch,
        );
    return m ? decode(m[2]) : undefined;
}

const LIST_KEYWORDS: ReadonlyMap<string, ListStyleType> = new Map<string, ListStyleType>([
    ["none", "none"],
    ["disc", "disc"],
    ["circle", "circle"],
    ["square", "square"],
    ["decimal", "decimal"],
    ["decimal-leading-zero", "decimal-leading-zero"],
    ["lower-alpha", "lower-alpha"],
    ["lower-latin", "lower-alpha"],
    ["upper-alpha", "upper-alpha"],
    ["upper-latin", "upper-alpha"],
    ["lower-roman", "lower-roman"],
    ["upper-roman", "upper-roman"],
    ["disclosure-closed", { string: "▸ " }],
    ["disclosure-open", { string: "▾ " }],
]);

/** A `list-style-type` value (keyword or string); undefined when unknown. */
export function parseListStyleType(token: string): ListStyleType | undefined {
    const s: string | undefined = cssString(token.trim());
    return s !== undefined ? { string: s } : LIST_KEYWORDS.get(token.trim().toLowerCase());
}

/** `counter-reset` / `-increment` / `-set`: `none` or `name [int]…`; undefined when malformed. */
export function parseCounterOps(value: string, defaultValue: number): CounterOp[] | undefined {
    const toks: string[] = tokens(value);
    const ops: CounterOp[] = [];
    let ok: boolean = toks.length > 0;
    if (toks.length === 1 && toks[0].toLowerCase() === "none") {
        ok = true;
    } else {
        for (let i: number = 0; i < toks.length && ok; i++) {
            const name: string = toks[i];
            const next: string | undefined = toks[i + 1];
            const isInt: boolean = next !== undefined && /^[+-]?\d+$/.test(next);
            ok = /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/.test(name) && name.toLowerCase() !== "none";
            ops.push({ name, value: isInt ? parseInt(next || "0", 10) : defaultValue });
            i += isInt ? 1 : 0;
        }
    }
    return ok ? ops : undefined;
}

/** A `content` value: items, `null` for `none`/`normal`, undefined when malformed. */
export function parseContent(value: string): ContentItem[] | null | undefined {
    const v: string = value.trim().toLowerCase();
    const items: ContentItem[] = [];
    let ok: boolean = true;
    let result: ContentItem[] | null | undefined;
    if (v === "none" || v === "normal") {
        result = null;
    } else {
        for (const tok of tokens(value)) {
            const str: string | undefined = cssString(tok);
            const fn: RegExpMatchArray | null = tok.match(/^([a-z-]+)\(([\s\S]*)\)$/i);
            const fname: string = fn ? fn[1].toLowerCase() : "";
            const args: string[] = fn ? splitTop(fn[2], "comma") : [];
            const style: ListStyleType | undefined = args.length > 0 ? parseListStyleType(args[args.length - 1]) : undefined;
            if (str !== undefined) {
                items.push({ kind: "string", text: str });
            } else if (tok.toLowerCase() === "open-quote") {
                items.push({ kind: "open-quote" });
            } else if (tok.toLowerCase() === "close-quote") {
                items.push({ kind: "close-quote" });
            } else if (/^no-(open|close)-quote$/i.test(tok)) {
                ok = ok && true;
            } else if (fname === "attr" && args.length >= 1) {
                items.push({ kind: "attr", name: args[0].split(/\s+/)[0].toLowerCase() });
            } else if (fname === "counter" && args.length >= 1) {
                items.push({ kind: "counter", name: args[0], style: args.length > 1 && style !== undefined ? style : "decimal" });
            } else if (fname === "counters" && args.length >= 2) {
                items.push({ kind: "counters", name: args[0], separator: cssString(args[1]) || "", style: args.length > 2 && style !== undefined ? style : "decimal" });
            } else if (fname === "url") {
                ok = ok && true;
            } else {
                ok = false;
            }
        }
        result = ok ? items : undefined;
    }
    return result;
}

function alpha(n: number, upper: boolean): string {
    let s: string = "";
    let k: number = n;
    while (k > 0) {
        k -= 1;
        s = String.fromCharCode(97 + (k % 26)) + s;
        k = Math.floor(k / 26);
    }
    return upper ? s.toUpperCase() : s;
}

function roman(n: number, upper: boolean): string {
    const table: Array<[number, string]> = [
        [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
        [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
    ];
    let s: string = "";
    let k: number = n;
    for (const [v, r] of table) {
        while (k >= v) {
            s += r;
            k -= v;
        }
    }
    return upper ? s.toUpperCase() : s;
}

/** A counter value in a counter style, without suffix (`3` → `iii`); bullets give their symbol. */
export function counterText(n: number, style: ListStyleType): string {
    let s: string;
    if (typeof style === "object") {
        s = style.string;
    } else if (style === "none") {
        s = "";
    } else if (style === "disc") {
        s = "•";
    } else if (style === "circle") {
        s = "◦";
    } else if (style === "square") {
        s = "▪";
    } else if (style === "decimal-leading-zero") {
        s = (n < 0 ? "-" : "") + String(Math.abs(n)).padStart(2, "0");
    } else if ((style === "lower-alpha" || style === "upper-alpha") && n > 0) {
        s = alpha(n, style === "upper-alpha");
    } else if ((style === "lower-roman" || style === "upper-roman") && n > 0 && n < 4000) {
        s = roman(n, style === "upper-roman");
    } else {
        s = String(n);
    }
    return s;
}

/** The marker a list item shows for counter value `n`: CSS Lists suffixes (`1. `, `• `, a string as given). */
export function markerText(n: number, style: ListStyleType): string {
    let s: string;
    if (typeof style === "object") {
        s = style.string;
    } else if (style === "none") {
        s = "";
    } else if (style === "disc" || style === "circle" || style === "square") {
        s = counterText(n, style) + " ";
    } else {
        s = counterText(n, style) + ". ";
    }
    return s;
}
