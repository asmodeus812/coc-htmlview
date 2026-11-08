/**
 * Low-level CSS text scanning shared by the sheet reader and the selector parser: comment stripping, top-level
 * block splitting (the per-rule recovery the `css` package lacks), declaration splitting and identifier helpers.
 * Every scanner respects strings, escapes and bracket nesting the way CSS Syntax 3 does. Pure; never throws.
 */
import type { Declaration } from "./index";

/** One top-level construct: `prelude { body }` (a qualified rule or block at-rule) or `prelude ;` (`body` absent). */
export interface Chunk {
    prelude: string;
    body?: string;
}

/** Whether `text[pos]` starts a quoted string; the returned index is just past its end (or the text end). */
function skipString(text: string, pos: number): number {
    const quote: string = text.charAt(pos);
    let i: number = pos + 1;
    let open: boolean = true;
    while (open && i < text.length) {
        const ch: string = text.charAt(i);
        if (ch === "\\") {
            i += 2;
        } else if (ch === quote || ch === "\n") {
            i += 1;
            open = false;
        } else {
            i += 1;
        }
    }
    return Math.min(i, text.length);
}

/** `text` with every comment replaced by a single space (strings and escapes kept verbatim). */
export function stripComments(text: string): string {
    let out: string = "";
    let i: number = 0;
    while (i < text.length) {
        const ch: string = text.charAt(i);
        if (ch === '"' || ch === "'") {
            const end: number = skipString(text, i);
            out += text.slice(i, end);
            i = end;
        } else if (ch === "\\") {
            out += text.slice(i, i + 2);
            i += 2;
        } else if (ch === "/" && text.charAt(i + 1) === "*") {
            const close: number = text.indexOf("*/", i + 2);
            out += " ";
            i = close < 0 ? text.length : close + 2;
        } else {
            out += ch;
            i += 1;
        }
    }
    return out;
}

/**
 * Splits comment-free sheet text into top-level chunks like a CSS tokenizer consumes a rule list: a `{…}` block
 * (nesting, strings and parentheses respected) closes a chunk, a `;` closes an at-rule statement, an unclosed block
 * at the end of input is closed implicitly (as browsers do). Stray `}` stay in the next prelude, which then fails
 * selector parsing and drops only that rule.
 */
export function splitTopLevel(text: string): Chunk[] {
    const chunks: Chunk[] = [];
    let start: number = 0;
    let i: number = 0;
    while (i < text.length) {
        const ch: string = text.charAt(i);
        if (ch === '"' || ch === "'") {
            i = skipString(text, i);
        } else if (ch === "\\") {
            i += 2;
        } else if (ch === ";" && text.slice(start, i).trim().startsWith("@")) {
            chunks.push({ prelude: text.slice(start, i).trim() });
            i += 1;
            start = i;
        } else if (ch === "{") {
            const end: number = blockEnd(text, i);
            chunks.push({ prelude: text.slice(start, i).trim(), body: text.slice(i + 1, end) });
            i = Math.min(end + 1, text.length);
            start = i;
        } else {
            i += 1;
        }
    }
    const tail: string = text.slice(start).trim();
    if (tail.startsWith("@")) {
        chunks.push({ prelude: tail });
    }
    return chunks;
}

/** Index of the `}` matching the `{` at `open` (or `text.length` when the block never closes). */
function blockEnd(text: string, open: number): number {
    let depth: number = 0;
    let i: number = open;
    let end: number = -1;
    while (end < 0 && i < text.length) {
        const ch: string = text.charAt(i);
        if (ch === '"' || ch === "'") {
            i = skipString(text, i);
        } else if (ch === "\\") {
            i += 2;
        } else {
            depth += ch === "{" || ch === "(" || ch === "[" ? 1 : ch === "}" || ch === ")" || ch === "]" ? -1 : 0;
            end = ch === "}" && depth <= 0 ? i : -1;
            i += 1;
        }
    }
    return end < 0 ? text.length : end;
}

/** Splits `text` on `sep` characters outside strings, escapes and `()`/`[]`/`{}` nesting. Pieces are untrimmed. */
export function splitOutside(text: string, sep: string): string[] {
    const pieces: string[] = [];
    let depth: number = 0;
    let start: number = 0;
    let i: number = 0;
    while (i < text.length) {
        const ch: string = text.charAt(i);
        if (ch === '"' || ch === "'") {
            i = skipString(text, i);
        } else if (ch === "\\") {
            i += 2;
        } else {
            if (ch === sep && depth <= 0) {
                pieces.push(text.slice(start, i));
                start = i + 1;
            } else {
                depth += ch === "(" || ch === "[" || ch === "{" ? 1 : ch === ")" || ch === "]" || ch === "}" ? -1 : 0;
            }
            i += 1;
        }
    }
    pieces.push(text.slice(start));
    return pieces;
}

const IMPORTANT: RegExp = /!\s*important\s*$/i;
const PROPERTY: RegExp = /^(--[^\s:]*|-?[_a-zA-Z][_a-zA-Z0-9-]*)$/;

/**
 * Builds a declaration from a raw property and value (comments already stripped), or `undefined` when invalid:
 * malformed property name, empty value on a normal property, a stray `!` other than `!important`. Normal
 * property names are lowercased, custom properties (`--x`) keep their case.
 */
export function makeDeclaration(rawProperty: string, rawValue: string): Declaration | undefined {
    const name: string = rawProperty.trim();
    const custom: boolean = name.startsWith("--");
    const important: boolean = IMPORTANT.test(rawValue);
    const value: string = rawValue.replace(IMPORTANT, "").trim();
    const valid: boolean = PROPERTY.test(name) && (custom || value.length > 0) && !/!\s*$/.test(value);
    return valid ? { property: custom ? name : name.toLowerCase(), value, important } : undefined;
}

/** Reads a declaration block body (`a: 1; b: 2 !important`); bad declarations are dropped, the rest kept. */
export function readDeclarations(body: string): Declaration[] {
    const out: Declaration[] = [];
    for (const piece of splitOutside(stripComments(body), ";")) {
        const colon: number = piece.indexOf(":");
        const decl: Declaration | undefined = colon > 0 ? makeDeclaration(piece.slice(0, colon), piece.slice(colon + 1)) : undefined;
        if (decl !== undefined) {
            out.push(decl);
        }
    }
    return out;
}
