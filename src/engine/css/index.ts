/**
 * Stylesheets, selectors and the cascade. Text in, rules out; elements in, ordered matching declarations out.
 * Values stay raw strings here (`"1em 0"`, `"var(--vscode-x, #fff)"`): typing them is style/'s job.
 *
 * Selector support (everything else parses to `{ kind: "unsupported" }`, which never matches, so a rule using it
 * is ignored like a browser ignores what it cannot match): type, universal, class, id, attribute (`[a]`, `=`,
 * `~=`, `|=`, `^=`, `$=`, `*=`, ` i` flag), combinators descendant, `>`, `+`, `~`, `:root`, `:not(<list>)`,
 * `:checked`, `:first-child`, `:last-child`, `:only-child`, `:nth-child(an+b)`, `:nth-last-child(an+b)`,
 * `:first-of-type`, `:last-of-type`, pseudo-elements `::before`, `::after`, `::marker` (and legacy `:before`,
 * `:after`). At-rules: `@media` blocks whose query is `screen`/`all` (or no query) apply, others are skipped;
 * `@import`, `@font-face`, `@keyframes` and every other at-rule are skipped. Bad CSS never throws: the broken rule
 * or declaration is dropped (a selector list with a syntax error drops its whole rule, as in a browser).
 *
 * Pure and synchronous; no nvim.
 */
import type { DomDocument, DomElement } from "../dom";
import { matchComplex } from "./match";
import { readDeclarations } from "./scan";
import { parseMembers } from "./selector";
import { readRules } from "./sheet";

/** Where a sheet comes from; decides precedence before specificity (see {@link cascadeRank}). */
export type Origin = "ua" | "user" | "author" | "inline";

/** `[a, b, c]` = (ids, classes + attributes + pseudo-classes, types + pseudo-elements). Compared lexicographically. */
export type Specificity = readonly [number, number, number];

export type AttributeOperator = "=" | "~=" | "|=" | "^=" | "$=" | "*=";

/** One simple selector of a compound. */
export type SimpleSelector =
    | { kind: "universal" }
    | { kind: "type"; name: string }
    | { kind: "class"; name: string }
    | { kind: "id"; name: string }
    /** `[name]` when `op` is absent; `value` already unquoted; `insensitive` from the ` i` flag. */
    | { kind: "attribute"; name: string; op?: AttributeOperator; value?: string; insensitive?: boolean }
    | { kind: "root" }
    /** Evaluated through the {@link CheckedHook} (interact/ form state), never the `checked` attribute directly. */
    | { kind: "checked" }
    /** `:first-child` = nth(0n+1); `:last-child` = nth-last(0n+1); `:only-child` = both; `*-of-type` set `ofType`. */
    | { kind: "nth"; a: number; b: number; fromEnd: boolean; ofType: boolean }
    | { kind: "not"; selectors: ComplexSelector[] }
    /** Anything not in the supported list (`:hover`, `:focus`, `:has()`, …): never matches. */
    | { kind: "unsupported"; text: string };

export interface CompoundSelector {
    /** Never empty (a lone `*` is `[{kind:"universal"}]`). */
    simples: SimpleSelector[];
}

/** `" "` descendant, `">"` child, `"+"` next sibling, `"~"` subsequent sibling. */
export type Combinator = " " | ">" | "+" | "~";

export type PseudoElement = "before" | "after" | "marker";

/** A complex selector: `compounds[0] combinators[0] compounds[1] …`, the subject being the last compound. */
export interface ComplexSelector {
    compounds: CompoundSelector[];
    /** `combinators.length === compounds.length - 1`; `combinators[i]` joins `compounds[i]` and `compounds[i + 1]`. */
    combinators: Combinator[];
    /** Set when the selector targets a pseudo-element of the subject (only valid at the end). */
    pseudo?: PseudoElement;
    specificity: Specificity;
    /** The selector as written, normalised whitespace (`.other-context-list .do::before`); used for group names. */
    text: string;
}

/** One declaration. `property` lowercase (custom properties keep their case: `--vscode-textLink-foreground`). */
export interface Declaration {
    property: string;
    /** Raw value, trimmed, without `!important`. */
    value: string;
    important: boolean;
}

/** A style rule. A selector list `a, b` is ONE rule with two selectors (each matches with its own specificity). */
export interface Rule {
    selectors: ComplexSelector[];
    declarations: Declaration[];
    /** Position of the rule in the whole cascade input (sheet order, then rule order); later wins ties. */
    order: number;
}

/** A parsed sheet. */
export interface Stylesheet {
    /** Identifies the sheet (`"ua.css"`, `"rule.css"`, `"<style>#1"`, `"inline"`); for cache keys and messages. */
    name: string;
    origin: Origin;
    rules: Rule[];
}

/**
 * A declaration that applies to an element (or one of its pseudo-elements), with everything the cascade sorts by.
 * `matchRules` returns them already sorted, lowest precedence first: for each property the LAST one wins.
 */
export interface MatchedDeclaration {
    declaration: Declaration;
    origin: Origin;
    specificity: Specificity;
    order: number;
    /** The matching selector (`undefined` for inline `style=""`); style/ names the rule's group from its `text`. */
    selector?: ComplexSelector;
}

/** `:checked` evaluation, supplied by interact/ ({@link import("../interact").isChecked} bound to a FormState). */
export type CheckedHook = (el: DomElement) => boolean;

/** Inputs of one match: the document, the parsed sheets in cascade order, and the dynamic state hooks. */
export interface MatchContext {
    doc: DomDocument;
    /** UA first, then user and author sheets in their given order; `Rule.order` is global across them. */
    sheets: readonly Stylesheet[];
    checked: CheckedHook;
}

/**
 * Parses `text` into a sheet of `origin`. `firstOrder` is the `order` of its first rule (the caller chains sheets:
 * the next sheet starts at `prev.firstOrder + prev.rules.length`). Never throws.
 */
export function parseSheet(text: string, origin: Origin, name: string, firstOrder: number): Stylesheet {
    return { name, origin, rules: readRules(text, firstOrder) };
}

/** Parses a `style=""` attribute body into declarations (origin `inline`). Never throws. */
export function parseInlineStyle(text: string): Declaration[] {
    return readDeclarations(text);
}

/** Parses one selector list (`"ul > li:first-child, .a::before"`); unparseable members are dropped. */
export function parseSelectorList(text: string): ComplexSelector[] {
    return parseMembers(text).filter((s: ComplexSelector | undefined): s is ComplexSelector => s !== undefined);
}

/** Whether `selector` matches element `el` (pseudo-element ignored: the caller filters by `pseudo`). */
export function matches(ctx: MatchContext, selector: ComplexSelector, el: DomElement): boolean {
    return matchComplex(ctx, selector, el);
}

/**
 * Every declaration that applies to `el` (`pseudo` undefined) or to its pseudo-element `pseudo`, the element's
 * own inline `style` included (origin `inline`, pseudo undefined only), sorted by {@link compareCascade}.
 */
export function matchRules(ctx: MatchContext, el: DomElement, pseudo?: PseudoElement): MatchedDeclaration[] {
    const out: MatchedDeclaration[] = [];
    let lastOrder: number = -1;
    for (const sheet of ctx.sheets) {
        for (const rule of sheet.rules) {
            lastOrder = Math.max(lastOrder, rule.order);
            // a rule matching through several of its selectors applies once, with the most specific one
            let best: ComplexSelector | undefined;
            for (const selector of rule.selectors) {
                const better: boolean = best === undefined || compareSpecificity(selector.specificity, best.specificity) > 0;
                best = selector.pseudo === pseudo && better && matchComplex(ctx, selector, el) ? selector : best;
            }
            for (const declaration of best ? rule.declarations : []) {
                out.push({ declaration, origin: sheet.origin, specificity: best ? best.specificity : [0, 0, 0], order: rule.order, selector: best });
            }
        }
    }
    const style: string | undefined = pseudo === undefined ? el.attrs.style : undefined;
    for (const declaration of style !== undefined ? readDeclarations(style) : []) {
        out.push({ declaration, origin: "inline", specificity: [0, 0, 0], order: lastOrder + 1 });
    }
    // Array.prototype.sort is stable: declarations of one rule keep their source order
    return out.sort(compareCascade);
}

// ---- conventions (implemented: every part must agree on them) ----

/**
 * Precedence tier of an origin/importance pair, CSS Cascade 4 (higher wins): ua normal 0, user normal 1, author
 * normal 2, inline normal 3, author important 4, inline important 5, user important 6, ua important 7.
 */
export function cascadeRank(origin: Origin, important: boolean): number {
    const normal: Record<Origin, number> = { ua: 0, user: 1, author: 2, inline: 3 };
    const strong: Record<Origin, number> = { ua: 7, user: 6, author: 4, inline: 5 };
    return important ? strong[origin] : normal[origin];
}

/** Lexicographic specificity comparison: negative when `a < b`, 0 when equal, positive when `a > b`. */
export function compareSpecificity(a: Specificity, b: Specificity): number {
    const d0: number = a[0] - b[0];
    const d1: number = a[1] - b[1];
    return d0 !== 0 ? d0 : d1 !== 0 ? d1 : a[2] - b[2];
}

/** Cascade order of two matched declarations: rank, then specificity, then order. Negative = `a` loses. */
export function compareCascade(a: MatchedDeclaration, b: MatchedDeclaration): number {
    const rank: number = cascadeRank(a.origin, a.declaration.important) - cascadeRank(b.origin, b.declaration.important);
    const spec: number = compareSpecificity(a.specificity, b.specificity);
    return rank !== 0 ? rank : spec !== 0 ? spec : a.order - b.order;
}
