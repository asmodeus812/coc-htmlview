/**
 * Selector parsing: text → {@link ComplexSelector} AST with specificity, including attribute selectors, sibling
 * combinators, structural and state pseudo-classes and escapes.
 *
 * Two failure modes, as in a browser: a SYNTAX error makes the member unparseable (`undefined`; the sheet reader
 * then drops the whole rule), while a well-formed but unsupported pseudo-class (`:hover`, `:has(…)`) becomes an
 * `unsupported` simple that never matches. Pure; never throws.
 */
import type {
    AttributeOperator,
    Combinator,
    ComplexSelector,
    CompoundSelector,
    PseudoElement,
    SimpleSelector,
    Specificity,
} from "./index";
import { splitOutside, stripComments } from "./scan";

const IDENT: RegExp = /^(?:--|-?(?:[_a-zA-Z\u0080-￿]|\\(?:[0-9a-fA-F]{1,6}\s?|[^\n0-9a-fA-F])))(?:[_a-zA-Z0-9\u0080-￿-]|\\(?:[0-9a-fA-F]{1,6}\s?|[^\n0-9a-fA-F]))*/;

interface Scan {
    text: string;
    pos: number;
    ok: boolean;
}

/** A compound being built, with its specificity counted from the source (`:only-child` is one pseudo-class). */
interface CompoundBuild {
    simples: SimpleSelector[];
    spec: [number, number, number];
    pseudo?: PseudoElement;
    text: string;
}

/** Resolves CSS escapes (`\:` → `:`, `\31 ` → `1`). */
function unescape(ident: string): string {
    return ident.replace(/\\([0-9a-fA-F]{1,6}\s?|[^\n])/g, (_m: string, esc: string) => {
        const hex: boolean = /^[0-9a-fA-F]/.test(esc);
        const code: number = hex ? parseInt(esc.trim(), 16) : -1;
        return hex ? String.fromCodePoint(code > 0 && code <= 0x10ffff ? code : 0xfffd) : esc;
    });
}

function readIdent(scan: Scan): string {
    const m: RegExpMatchArray | null = scan.text.slice(scan.pos).match(IDENT);
    const raw: string = m ? m[0] : "";
    scan.pos += raw.length;
    scan.ok = scan.ok && raw.length > 0;
    return unescape(raw);
}

function skipSpace(scan: Scan): void {
    while (scan.pos < scan.text.length && /\s/.test(scan.text.charAt(scan.pos))) {
        scan.pos += 1;
    }
}

/** Reads a balanced `( … )` at `scan.pos` and returns the inside (strings and nesting respected). */
function readParen(scan: Scan): string {
    const ok: boolean = scan.text.charAt(scan.pos) === "(";
    const pieces: string[] = ok ? splitOutside(scan.text.slice(scan.pos + 1), ")") : [];
    const closed: boolean = pieces.length > 1;
    const inner: string = closed ? pieces[0] : "";
    scan.pos = closed ? scan.pos + inner.length + 2 : scan.text.length;
    scan.ok = scan.ok && closed;
    return inner;
}

/**
 * Parses `an+b` (`odd`, `even`, `3`, `-n+2`, `2n - 1`); `undefined` when malformed or when it carries an
 * `of <selector>` clause (unsupported).
 */
function parseNth(text: string): { a: number; b: number } | undefined {
    const t: string = text.trim().toLowerCase();
    const m: RegExpMatchArray | null = t.match(/^(?:([+-]?\d*)n\s*(?:([+-])\s*(\d+))?|([+-]?\d+))$/);
    let result: { a: number; b: number } | undefined;
    if (t === "odd") {
        result = { a: 2, b: 1 };
    } else if (t === "even") {
        result = { a: 2, b: 0 };
    } else if (m && m[4] !== undefined) {
        result = { a: 0, b: parseInt(m[4], 10) };
    } else if (m) {
        const coef: string = m[1];
        const a: number = coef === "" || coef === "+" ? 1 : coef === "-" ? -1 : parseInt(coef, 10);
        const b: number = m[3] === undefined ? 0 : (m[2] === "-" ? -1 : 1) * parseInt(m[3], 10);
        result = { a, b };
    }
    return result;
}

function nth(a: number, b: number, fromEnd: boolean, ofType: boolean): SimpleSelector {
    return { kind: "nth", a, b, fromEnd, ofType };
}

/** The structural pseudo-classes without argument, as nth simples. */
const STRUCTURAL: Readonly<Record<string, SimpleSelector[]>> = {
    "first-child": [nth(0, 1, false, false)],
    "last-child": [nth(0, 1, true, false)],
    "only-child": [nth(0, 1, false, false), nth(0, 1, true, false)],
    "first-of-type": [nth(0, 1, false, true)],
    "last-of-type": [nth(0, 1, true, true)],
    "only-of-type": [nth(0, 1, false, true), nth(0, 1, true, true)],
};

/** The functional structural pseudo-classes: name → [fromEnd, ofType]. */
const NTH_FUNCTIONS: Readonly<Record<string, [boolean, boolean]>> = {
    "nth-child": [false, false],
    "nth-last-child": [true, false],
    "nth-of-type": [false, true],
    "nth-last-of-type": [true, true],
};

function maxSpecificity(list: ComplexSelector[]): [number, number, number] {
    let best: [number, number, number] = [0, 0, 0];
    for (const s of list) {
        const sp: Specificity = s.specificity;
        const greater: boolean = sp[0] !== best[0] ? sp[0] > best[0] : sp[1] !== best[1] ? sp[1] > best[1] : sp[2] > best[2];
        best = greater ? [sp[0], sp[1], sp[2]] : best;
    }
    return best;
}

/** Applies one `:name` / `::name` (the leading `:` already consumed) to `c`. */
function readPseudo(scan: Scan, c: CompoundBuild): void {
    const doubled: boolean = scan.text.charAt(scan.pos) === ":";
    scan.pos += doubled ? 1 : 0;
    const start: number = scan.pos;
    const name: string = readIdent(scan).toLowerCase();
    const functional: boolean = scan.ok && scan.text.charAt(scan.pos) === "(";
    const arg: string = functional ? readParen(scan) : "";
    const text: string = ":" + (doubled ? ":" : "") + scan.text.slice(start, scan.pos);
    if (!scan.ok) {
        // malformed name or argument: the syntax error is already recorded in scan.ok
    } else if (!functional && (name === "before" || name === "after" || (doubled && name === "marker"))) {
        c.pseudo = name as PseudoElement;
        c.spec[2] += 1;
    } else if (doubled) {
        // unknown pseudo-element (`::selection`, `::-webkit-scrollbar`): valid, never matches
        c.simples.push({ kind: "unsupported", text });
        c.spec[2] += 1;
    } else if (!functional && name === "root") {
        c.simples.push({ kind: "root" });
        c.spec[1] += 1;
    } else if (!functional && name === "checked") {
        c.simples.push({ kind: "checked" });
        c.spec[1] += 1;
    } else if (!functional && STRUCTURAL[name] !== undefined) {
        c.simples.push(...STRUCTURAL[name].map((s: SimpleSelector) => ({ ...s })));
        c.spec[1] += 1;
    } else if (functional && NTH_FUNCTIONS[name] !== undefined) {
        const ab: { a: number; b: number } | undefined = parseNth(arg);
        const flags: [boolean, boolean] = NTH_FUNCTIONS[name];
        c.simples.push(ab ? nth(ab.a, ab.b, flags[0], flags[1]) : { kind: "unsupported", text });
        c.spec[1] += 1;
    } else if (functional && name === "not") {
        const members: Array<ComplexSelector | undefined> = parseMembers(arg);
        const ok: boolean = members.length > 0 && members.every((m: ComplexSelector | undefined) => m !== undefined && m.pseudo === undefined);
        const list: ComplexSelector[] = members.filter((m): m is ComplexSelector => m !== undefined);
        c.simples.push(ok ? { kind: "not", selectors: list } : { kind: "unsupported", text });
        const sp: [number, number, number] = maxSpecificity(list);
        c.spec = [c.spec[0] + sp[0], c.spec[1] + sp[1], c.spec[2] + sp[2]];
    } else {
        c.simples.push({ kind: "unsupported", text });
        c.spec[1] += 1;
    }
}

const ATTR: RegExp = /^\s*([~|^$*]?=)\s*/;

/** Reads `[name op value flag]` (the `[` already consumed). Namespaced attributes are unsupported. */
function readAttribute(scan: Scan, c: CompoundBuild): void {
    const start: number = scan.pos - 1;
    skipSpace(scan);
    const name: string = readIdent(scan).toLowerCase();
    const namespaced: boolean = scan.text.charAt(scan.pos) === "|" && scan.text.charAt(scan.pos + 1) !== "=";
    const opMatch: RegExpMatchArray | null = namespaced ? null : scan.text.slice(scan.pos).match(ATTR);
    let value: string | undefined;
    let insensitive: boolean = false;
    if (opMatch) {
        scan.pos += opMatch[0].length;
        const quote: string = scan.text.charAt(scan.pos);
        if (quote === '"' || quote === "'") {
            const m: RegExpMatchArray | null = scan.text.slice(scan.pos).match(quote === '"' ? /^"((?:[^"\\\n]|\\.)*)"/ : /^'((?:[^'\\\n]|\\.)*)'/);
            value = m ? unescape(m[1]) : "";
            scan.pos += m ? m[0].length : 0;
            scan.ok = scan.ok && m !== null;
        } else {
            value = readIdent(scan);
        }
        skipSpace(scan);
        const flag: RegExpMatchArray | null = scan.text.slice(scan.pos).match(/^([iIsS])(?![-\w])\s*/);
        insensitive = flag !== null && flag[1].toLowerCase() === "i";
        scan.pos += flag ? flag[0].length : 0;
    }
    skipSpace(scan);
    const closeIdx: number = namespaced ? scan.text.indexOf("]", scan.pos) : scan.pos;
    scan.ok = scan.ok && scan.text.charAt(closeIdx) === "]";
    scan.pos = scan.ok ? closeIdx + 1 : scan.text.length;
    const op: AttributeOperator | undefined = opMatch ? (opMatch[1] as AttributeOperator) : undefined;
    const simple: SimpleSelector = namespaced
        ? { kind: "unsupported", text: scan.text.slice(start, scan.pos) }
        : { kind: "attribute", name, ...(op ? { op, value } : {}), ...(insensitive ? { insensitive } : {}) };
    c.simples.push(simple);
    c.spec[1] += 1;
}

/** Reads one compound at `scan.pos`. Anything after a pseudo-element other than a combinator/end is unsupported. */
function readCompound(scan: Scan): CompoundBuild {
    const start: number = scan.pos;
    const c: CompoundBuild = { simples: [], spec: [0, 0, 0], text: "" };
    if (scan.text.charAt(scan.pos) === "*") {
        scan.pos += 1;
        c.simples.push({ kind: "universal" });
    } else if (IDENT.test(scan.text.slice(scan.pos))) {
        c.simples.push({ kind: "type", name: readIdent(scan).toLowerCase() });
        c.spec[2] += 1;
    }
    let more: boolean = true;
    while (scan.ok && more && scan.pos < scan.text.length) {
        const ch: string = scan.text.charAt(scan.pos);
        const afterPseudo: boolean = c.pseudo !== undefined;
        if (ch === "." || ch === "#" || ch === ":" || ch === "[") {
            scan.pos += 1;
        }
        if (afterPseudo && /[.#[]/.test(ch)) {
            scan.ok = false;
        } else if (ch === ".") {
            c.simples.push({ kind: "class", name: readIdent(scan) });
            c.spec[1] += 1;
        } else if (ch === "#") {
            c.simples.push({ kind: "id", name: readIdent(scan) });
            c.spec[0] += 1;
        } else if (ch === ":") {
            const before: number = c.simples.length;
            const hadPseudo: PseudoElement | undefined = c.pseudo;
            readPseudo(scan, c);
            // `::before:hover` and the like: keep it well-formed but never matching
            const tail: boolean = afterPseudo && (c.simples.length > before || c.pseudo !== hadPseudo);
            c.simples.push(...(tail ? [{ kind: "unsupported", text: "pseudo-element state" } as SimpleSelector] : []));
        } else if (ch === "[") {
            readAttribute(scan, c);
        } else {
            more = false;
        }
    }
    scan.ok = scan.ok && scan.pos > start;
    c.text = scan.text.slice(start, scan.pos);
    c.simples = c.simples.length > 0 ? c.simples : [{ kind: "universal" }];
    return c;
}

/** Parses one complex selector (no top-level comma); `undefined` on a syntax error. */
export function parseComplex(source: string): ComplexSelector | undefined {
    const scan: Scan = { text: stripComments(source).trim(), pos: 0, ok: false };
    scan.ok = scan.text.length > 0;
    const compounds: CompoundSelector[] = [];
    const combinators: Combinator[] = [];
    const spec: [number, number, number] = [0, 0, 0];
    let text: string = "";
    let pseudo: PseudoElement | undefined;
    while (scan.ok && scan.pos < scan.text.length) {
        scan.ok = pseudo === undefined;
        const c: CompoundBuild = readCompound(scan);
        compounds.push({ simples: c.simples });
        spec[0] += c.spec[0];
        spec[1] += c.spec[1];
        spec[2] += c.spec[2];
        pseudo = c.pseudo;
        text += c.text;
        const rest: RegExpMatchArray | null = scan.text.slice(scan.pos).match(/^\s*([>+~]?)\s*/);
        const sep: string = rest ? rest[0] : "";
        const comb: string = rest ? rest[1] : "";
        scan.pos += sep.length;
        const atEnd: boolean = scan.pos >= scan.text.length;
        scan.ok = scan.ok && (atEnd ? comb === "" : sep.length > 0);
        if (!atEnd) {
            combinators.push((comb === "" ? " " : comb) as Combinator);
            text += comb === "" ? " " : " " + comb + " ";
        }
    }
    const ok: boolean = scan.ok && compounds.length > 0 && combinators.length === compounds.length - 1;
    return ok ? { compounds, combinators, ...(pseudo ? { pseudo } : {}), specificity: spec, text } : undefined;
}

/** Every member of a selector list in order; `undefined` marks a member with a syntax error. */
export function parseMembers(text: string): Array<ComplexSelector | undefined> {
    return splitOutside(stripComments(text), ",").map((member: string) => parseComplex(member));
}
