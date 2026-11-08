/**
 * Selector matching over the plain DOM: right to left, with parents and siblings found through
 * `DomDocument.parent` / `DomDocument.nodes` (the tree has no parent pointers). Replaces the old ancestor-chain
 * model. Pure; never throws.
 */
import type { DomDocument, DomElement, DomNode } from "../dom";
import type { ComplexSelector, CompoundSelector, MatchContext, SimpleSelector } from "./index";

/** The parent element of `el`, or undefined for the root. */
function parentOf(doc: DomDocument, el: DomElement): DomElement | undefined {
    const p: number = el.id >= 0 && el.id < doc.parent.length ? doc.parent[el.id] : -1;
    const node: DomNode | undefined = p >= 0 ? doc.nodes[p] : undefined;
    return node !== undefined && node.type === "element" ? node : undefined;
}

/** `el` and its element siblings in order (just `[el]` for the root). */
function siblingsOf(doc: DomDocument, el: DomElement): DomElement[] {
    const parent: DomElement | undefined = parentOf(doc, el);
    const kids: readonly DomNode[] = parent ? parent.children : [el];
    return kids.filter((n: DomNode): n is DomElement => n.type === "element");
}

/** Whether the 1-based position `pos` satisfies `an+b` for some n ≥ 0. */
function nthFits(a: number, b: number, pos: number): boolean {
    const diff: number = pos - b;
    return a === 0 ? diff === 0 : diff / a >= 0 && diff % a === 0;
}

function matchesAttribute(s: Extract<SimpleSelector, { kind: "attribute" }>, el: DomElement): boolean {
    const has: boolean = Object.prototype.hasOwnProperty.call(el.attrs, s.name);
    const fold = (v: string): string => (s.insensitive ? v.toLowerCase() : v);
    const actual: string = has ? fold(el.attrs[s.name]) : "";
    const want: string = fold(s.value || "");
    let ok: boolean = has;
    if (has && s.op === "=") {
        ok = actual === want;
    } else if (has && s.op === "~=") {
        ok = want !== "" && !/\s/.test(want) && actual.split(/[ \t\n\f\r]+/).includes(want);
    } else if (has && s.op === "|=") {
        ok = actual === want || actual.startsWith(want + "-");
    } else if (has && s.op === "^=") {
        ok = want !== "" && actual.startsWith(want);
    } else if (has && s.op === "$=") {
        ok = want !== "" && actual.endsWith(want);
    } else if (has && s.op === "*=") {
        ok = want !== "" && actual.includes(want);
    }
    return ok;
}

function matchesNth(ctx: MatchContext, s: Extract<SimpleSelector, { kind: "nth" }>, el: DomElement): boolean {
    const all: DomElement[] = siblingsOf(ctx.doc, el);
    const pool: DomElement[] = s.ofType ? all.filter((e: DomElement) => e.tag === el.tag) : all;
    const index: number = pool.findIndex((e: DomElement) => e.id === el.id);
    const pos: number = s.fromEnd ? pool.length - index : index + 1;
    return index >= 0 && nthFits(s.a, s.b, pos);
}

function matchesSimple(ctx: MatchContext, s: SimpleSelector, el: DomElement): boolean {
    let ok: boolean = false;
    if (s.kind === "universal") {
        ok = true;
    } else if (s.kind === "type") {
        ok = el.tag === s.name;
    } else if (s.kind === "class") {
        ok = el.classList.includes(s.name);
    } else if (s.kind === "id") {
        ok = el.attrs.id === s.name;
    } else if (s.kind === "attribute") {
        ok = matchesAttribute(s, el);
    } else if (s.kind === "root") {
        ok = el.id === ctx.doc.root.id;
    } else if (s.kind === "checked") {
        ok = ctx.checked(el);
    } else if (s.kind === "nth") {
        ok = matchesNth(ctx, s, el);
    } else if (s.kind === "not") {
        ok = !s.selectors.some((sel: ComplexSelector) => matchComplex(ctx, sel, el));
    }
    return ok;
}

function matchesCompound(ctx: MatchContext, c: CompoundSelector, el: DomElement): boolean {
    return c.simples.every((s: SimpleSelector) => matchesSimple(ctx, s, el));
}

/** Whether `sel.compounds[0..part]` matches with `compounds[part]` on `el` (backtracking over combinators). */
function matchFrom(ctx: MatchContext, sel: ComplexSelector, part: number, el: DomElement): boolean {
    let matched: boolean = matchesCompound(ctx, sel.compounds[part], el);
    if (matched && part > 0) {
        const comb: string = sel.combinators[part - 1];
        if (comb === ">") {
            const parent: DomElement | undefined = parentOf(ctx.doc, el);
            matched = parent !== undefined && matchFrom(ctx, sel, part - 1, parent);
        } else if (comb === " ") {
            let found: boolean = false;
            for (let p: DomElement | undefined = parentOf(ctx.doc, el); p !== undefined && !found; p = parentOf(ctx.doc, p)) {
                found = matchFrom(ctx, sel, part - 1, p);
            }
            matched = found;
        } else {
            const sibs: DomElement[] = siblingsOf(ctx.doc, el);
            const index: number = sibs.findIndex((e: DomElement) => e.id === el.id);
            const candidates: DomElement[] = comb === "+" ? sibs.slice(Math.max(index - 1, 0), Math.max(index, 0)) : sibs.slice(0, Math.max(index, 0));
            matched = candidates.some((e: DomElement) => matchFrom(ctx, sel, part - 1, e));
        }
    }
    return matched;
}

/** Whether `sel` matches `el` (its pseudo-element is not checked). */
export function matchComplex(ctx: MatchContext, sel: ComplexSelector, el: DomElement): boolean {
    return sel.compounds.length > 0 && matchFrom(ctx, sel, sel.compounds.length - 1, el);
}
