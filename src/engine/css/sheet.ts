/**
 * Sheet text → {@link Rule}s. The sheet is split into top-level chunks first ({@link splitTopLevel}: the `css`
 * package silently loses every rule after a stray `}`), so a broken rule costs only itself, as in a browser; each
 * chunk's declarations are read with the `css` package, and with
 * {@link readDeclarations} when the package rejects the chunk. `@media` applies per {@link mediaApplies}; other
 * at-rules are skipped. Pure; never throws.
 */
import * as css from "css";
import type { ComplexSelector, Declaration, Rule } from "./index";
import { makeDeclaration, readDeclarations, splitOutside, splitTopLevel, stripComments } from "./scan";
import { parseMembers } from "./selector";

/** The subset of the `css` AST read here (the package ships no types). */
interface CssNode {
    type: string;
    selectors?: string[];
    declarations?: CssNode[];
    property?: string;
    value?: string;
}

/** A rule before numbering. */
interface RawRule {
    selectors: ComplexSelector[];
    declarations: Declaration[];
}

/** Parses with the `css` package; `undefined` when it throws or reports any error. */
function cssAst(text: string): CssNode[] | undefined {
    let nodes: CssNode[] | undefined;
    try {
        const ast = css.parse(text, { silent: true });
        const errors: unknown[] = (ast && ast.stylesheet && ast.stylesheet.parsingErrors) || [];
        nodes = errors.length === 0 && ast && ast.stylesheet ? ast.stylesheet.rules || [] : undefined;
    } catch {
        nodes = undefined;
    }
    return nodes;
}

/**
 * Whether an `@media` query list applies to the terminal: no query, or any member that is `all`/`screen`
 * (optionally `only`), without feature conditions.
 */
function mediaApplies(query: string): boolean {
    const members: string[] = splitOutside(stripComments(query), ",").map((m: string) => m.trim().toLowerCase());
    return query.trim() === "" || members.some((m: string) => /^(only\s+)?(all|screen)$/.test(m));
}

/** The selectors of a prelude, or `undefined` when any member has a syntax error (the browser drops the rule). */
function selectorsOf(prelude: string): ComplexSelector[] | undefined {
    const members: Array<ComplexSelector | undefined> = parseMembers(prelude);
    const ok: boolean = members.every((m: ComplexSelector | undefined) => m !== undefined);
    return ok ? (members as ComplexSelector[]) : undefined;
}

function astDeclarations(node: CssNode): Declaration[] {
    const out: Declaration[] = [];
    for (const d of node.declarations || []) {
        const decl: Declaration | undefined =
            d.type === "declaration" && d.property !== undefined ? makeDeclaration(d.property, d.value || "") : undefined;
        if (decl !== undefined) {
            out.push(decl);
        }
    }
    return out;
}

/** Declarations of one chunk body: the `css` package when it accepts the chunk, our reader otherwise. */
function chunkDeclarations(body: string): Declaration[] {
    const nodes: CssNode[] | undefined = /[{}]/.test(body) ? undefined : cssAst("x{" + body + "}");
    const rule: CssNode | undefined = nodes && nodes.length === 1 && nodes[0].type === "rule" ? nodes[0] : undefined;
    return rule ? astDeclarations(rule) : readDeclarations(body);
}

/** Rules from top-level chunks (recovery path). */
function fromChunks(text: string, out: RawRule[]): void {
    for (const chunk of splitTopLevel(text)) {
        const media: RegExpMatchArray | null = chunk.prelude.match(/^@media(?![-\w])([\s\S]*)$/i);
        const selectors: ComplexSelector[] | undefined =
            chunk.body !== undefined && !chunk.prelude.startsWith("@") ? selectorsOf(chunk.prelude) : undefined;
        if (selectors !== undefined) {
            out.push({ selectors, declarations: chunkDeclarations(chunk.body || "") });
        } else if (media && chunk.body !== undefined && mediaApplies(media[1])) {
            fromChunks(chunk.body, out);
        }
    }
}

/** Reads `text` into numbered rules starting at `firstOrder`. */
export function readRules(text: string, firstOrder: number): Rule[] {
    const raw: RawRule[] = [];
    fromChunks(stripComments(text), raw);
    return raw.map((r: RawRule, i: number): Rule => ({ selectors: r.selectors, declarations: r.declarations, order: firstOrder + i }));
}
