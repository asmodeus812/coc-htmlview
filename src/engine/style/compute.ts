/**
 * The cascade-to-computed-style walk (private to style/); `index.ts` exposes it as `computeStyles`/`parseSheets`.
 *
 * Per element: matched declarations (css.matchRules, sorted lowest first) → custom properties (inherited, var()
 * substituted, layout hints not inherited) → longhand winners (shorthands expanded after var() substitution; a
 * value invalid at computed-value time becomes `unset`) → typed computed values (initial / inherit / unset,
 * `currentcolor`, `bolder`/`lighter`, blockification of flex/grid items and the root) → counters (reset,
 * increment, set; implicit `list-item`; `start`/`value` attribute hints) → `::before`/`::after`/`::marker` →
 * paint groups. Pure: every mutable structure lives in one run.
 */
import type { DomDocument, DomElement, DomNode } from "../dom";
import type { ComplexSelector, CompoundSelector, MatchContext, MatchedDeclaration, Origin, PseudoElement, Stylesheet as ParsedSheet } from "../css";
import { compareCascade, matchRules, parseSheet } from "../css";
import type { FormState } from "../interact";
import { isChecked } from "../interact";
import type {
    BorderSide,
    Borders,
    Color,
    ComputedStyle,
    ContentItem,
    CounterOp,
    Display,
    Edges,
    ListStyleType,
    SheetSource,
    StyledElement,
    StyledNode,
    StyledPseudo,
    StyledTree,
    StyleEnv,
    TextDecoration,
} from "./index";
import { initialStyle, LayoutHint, UA_SHEET } from "./index";
import { blockify, displayOf, expandDeclaration, INHERITED, parseValue, SIDES } from "./properties";
import type { AlignItems } from "./index";
import type { DecorationLine, DisplayValue, ParsedValue, Side } from "./properties";
import { counterText, hasVar, markerText, resolveCustom, substitute, wideKeyword } from "./values";
import { borderGroups, colorPaint, hostGroupDefs, newBook, paintFor } from "./groups";
import type { GroupBook } from "./groups";

/** The UA sheet (origin ua) then `sources`, `Rule.order` chained across sheets. */
export function parseSheets(sources: readonly SheetSource[]): ParsedSheet[] {
    const out: ParsedSheet[] = [];
    let next: number = 0;
    const all: SheetSource[] = [{ name: "ua.css", text: UA_SHEET, origin: "ua" }, ...sources];
    for (const src of all) {
        const sheet: ParsedSheet = parseSheet(src.text, src.origin, src.name, next);
        next = nextOrder([sheet], next);
        out.push(sheet);
    }
    return out;
}

/** The first free `Rule.order` after `sheets` (at least `floor`). */
function nextOrder(sheets: readonly ParsedSheet[], floor: number): number {
    let n: number = floor;
    for (const sheet of sheets) {
        for (const rule of sheet.rules) {
            n = Math.max(n, rule.order + 1);
        }
    }
    return n;
}

// ---------------------------------------------------------------- document with the theme class

/** A copy of `doc` whose body carries `cls` (ancestors and the node table rebuilt; other nodes shared). */
function withBodyClass(doc: DomDocument, cls: string): DomDocument {
    const body: DomElement = doc.body;
    const has: boolean = body.classList.includes(cls);
    const classList: string[] = has ? body.classList.slice() : body.classList.concat([cls]);
    const newBody: DomElement = { ...body, classList, attrs: { ...body.attrs, class: classList.join(" ") } };
    const nodes: DomNode[] = doc.nodes.slice();
    nodes[body.id] = newBody;
    let child: DomElement = newBody;
    let p: number = doc.parent[body.id];
    while (p !== undefined && p >= 0) {
        const old: DomNode = doc.nodes[p];
        const prevChild: DomElement = child;
        const replaced: DomElement | undefined = old.type === "element"
            ? { ...old, children: old.children.map((c: DomNode) => (c.id === prevChild.id ? prevChild : c)) }
            : undefined;
        if (replaced !== undefined) {
            nodes[p] = replaced;
            child = replaced;
        }
        p = replaced !== undefined ? doc.parent[p] : -1;
    }
    const root: DomNode = nodes[doc.root.id];
    return has ? doc : { ...doc, body: newBody, root: root.type === "element" ? root : doc.root, nodes };
}

// ---------------------------------------------------------------- counters

interface Counter {
    value: number;
    /** Parent element id of the element that created it (siblings replace each other's counters). */
    owner: number;
}

type CounterScope = Map<string, Counter[]>;

function copyScope(scope: CounterScope): CounterScope {
    const out: CounterScope = new Map<string, Counter[]>();
    scope.forEach((v: Counter[], k: string) => out.set(k, v.slice()));
    return out;
}

function topCounter(scope: CounterScope, name: string, owner: number): Counter {
    const list: Counter[] = scope.get(name) || [];
    const top: Counter | undefined = list[list.length - 1];
    const counter: Counter = top !== undefined ? top : { value: 0, owner };
    if (top === undefined) {
        scope.set(name, list.concat([counter]));
    }
    return counter;
}

/** Applies resets, then increments (plus the implicit list-item one), then sets (CSS Lists 3 order). */
function applyCounters(scope: CounterScope, style: ComputedStyle, owner: number, listItem: boolean): void {
    for (const op of style.counterReset) {
        const list: Counter[] = scope.get(op.name) || [];
        const top: Counter | undefined = list[list.length - 1];
        const kept: Counter[] = top !== undefined && top.owner === owner ? list.slice(0, -1) : list;
        scope.set(op.name, kept.concat([{ value: op.value, owner }]));
    }
    const implicit: CounterOp[] = listItem && !style.counterIncrement.some((op: CounterOp) => op.name === "list-item") ? [{ name: "list-item", value: 1 }] : [];
    for (const op of style.counterIncrement.concat(implicit)) {
        topCounter(scope, op.name, owner).value += op.value;
    }
    for (const op of style.counterSet) {
        topCounter(scope, op.name, owner).value = op.value;
    }
}

// ---------------------------------------------------------------- one run

interface Run {
    ctx: MatchContext;
    env: StyleEnv;
    book: GroupBook;
    /** Nesting depth of `open-quote` (CSS quotes). */
    quoteDepth: number;
}

/** The layout hint names (computed lazily: index.ts and this module import each other). */
function isHint(name: string): boolean {
    return (Object.values(LayoutHint) as string[]).includes(name);
}
const FLEX_OR_GRID: ReadonlySet<string> = new Set<string>(["flex", "inline-flex", "grid", "inline-grid"]);

/** The computed style plus the raw display keyword (blockification of the children needs it). */
interface Computed {
    style: ComputedStyle;
    raw: string;
    /** The colour comes from a non-UA declaration, on this element or the ancestor it inherits it from. */
    authorColor: boolean;
    /** The UA colour declaration yielded to the inherited author colour, so the element paints that colour back. */
    yielded: boolean;
}

function inheritedCustom(parent: ComputedStyle | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (parent !== undefined) {
        for (const k of Object.keys(parent.custom)) {
            if (!isHint(k)) {
                out[k] = parent.custom[k];
            }
        }
    }
    return out;
}

/** Longhand → winning raw value (var()-substituted), from the sorted matched declarations. */
function winners(matched: readonly MatchedDeclaration[], custom: Readonly<Record<string, string>>, env: StyleEnv): Map<string, string> {
    const out: Map<string, string> = new Map<string, string>();
    const lookup = (n: string): string | undefined => custom[n];
    for (const m of matched) {
        const prop: string = m.declaration.property;
        const raw: string = m.declaration.value;
        const sub: string | undefined = prop.startsWith("--") ? undefined : substitute(raw, lookup, env.vars);
        const expanded: Array<[string, string]> | undefined = sub !== undefined ? expandDeclaration(prop, sub, env.vars) : undefined;
        const unset: Array<[string, string]> = !prop.startsWith("--") && expanded === undefined && hasVar(raw) ? expandDeclaration(prop, "unset", env.vars) || [] : [];
        for (const [lh, v] of (expanded || []).concat(unset)) {
            out.set(lh, v);
        }
    }
    return out;
}

type Source = { kind: "parent" } | { kind: "initial" } | { kind: "value"; value: ParsedValue };

/** Where a longhand's computed value comes from (inherit / initial / unset resolved; root inherits initial). */
function sourceOf(lh: string, win: ReadonlyMap<string, string>, env: StyleEnv, hasParent: boolean): Source {
    const raw: string | undefined = win.get(lh);
    const kw: string | undefined = raw !== undefined ? wideKeyword(raw) : undefined;
    const inherit: boolean = kw === "inherit" || ((kw === "unset" || raw === undefined) && INHERITED.has(lh));
    const parsed: ParsedValue | undefined = raw !== undefined && kw === undefined ? parseValue(lh, raw, env.vars) : undefined;
    let src: Source;
    if (inherit && hasParent) {
        src = { kind: "parent" };
    } else if (raw === undefined || kw !== undefined || parsed === undefined) {
        src = { kind: "initial" };
    } else {
        src = { kind: "value", value: parsed };
    }
    return src;
}

function bolder(w: number): number {
    return w < 350 ? 400 : w < 550 ? 700 : 900;
}

function lighter(w: number): number {
    return w < 550 ? 100 : w < 750 ? 400 : 700;
}

function isColor(v: ParsedValue): v is Color {
    return v !== null && typeof v === "object" && ("hex" in v || "var" in v || "group" in v);
}

/** Resolves the cascade of one element or pseudo-element into its computed style. */
function cascade(run: Run, matched: readonly MatchedDeclaration[], parent: Computed | undefined, blockifyIt: boolean): Computed {
    const env: StyleEnv = run.env;
    const declared: Map<string, string> = new Map<string, string>();
    for (const m of matched) {
        if (m.declaration.property.startsWith("--")) {
            declared.set(m.declaration.property, m.declaration.value);
        }
    }
    const custom: Record<string, string> = resolveCustom(declared, inheritedCustom(parent && parent.style), env.vars);
    const win: Map<string, string> = winners(matched, custom, env);
    const init: ComputedStyle = initialStyle();
    const ps: ComputedStyle = parent !== undefined ? parent.style : init;
    const src = (lh: string): Source => sourceOf(lh, win, env, parent !== undefined);
    const pick = <T>(lh: string, fromParent: T, initial: T, typed: (v: ParsedValue) => T): T => {
        const s: Source = src(lh);
        return s.kind === "parent" ? fromParent : s.kind === "initial" ? initial : typed(s.value);
    };
    // A heading's UA colour stands in for the font size a browser would draw it with, in the colour it inherits: it
    // yields to an author colour the heading inherits (a white header's h1 stays white).
    const colorDecl: MatchedDeclaration | undefined = matched.filter((m: MatchedDeclaration) => m.declaration.property === "color").pop();
    const fromParent: boolean = src("color").kind === "parent";
    const yields: boolean = parent !== undefined && parent.authorColor && colorDecl !== undefined && colorDecl.origin === "ua" && custom[LayoutHint.heading] !== undefined;
    const authorColor: boolean = yields || (fromParent ? parent !== undefined && parent.authorColor : colorDecl !== undefined && colorDecl.origin !== "ua");
    const ownColor: Color = pick<Color>("color", ps.color, init.color, (v: ParsedValue) => (v === "currentcolor" ? ps.color : isColor(v) ? v : init.color));
    const color: Color = yields ? ps.color : ownColor;
    const colorOf = (v: ParsedValue, fallback: Color): Color => (v === "currentcolor" ? color : isColor(v) ? v : fallback);
    const disp: DisplayValue = pick<DisplayValue>("display", { raw: parent ? parent.raw : "inline", display: ps.display }, { raw: "inline", display: "inline" }, (v: ParsedValue) => v as DisplayValue);
    const raw: string = blockifyIt ? blockify(disp.raw) : disp.raw;
    const flexDir: string = pick<string>("flex-direction", "row", "row", (v: ParsedValue) => String(v));
    const baseDisplay: Display = displayOf(raw) || disp.display;
    const display: Display = baseDisplay === "flex" && /^column/.test(flexDir) ? "block" : baseDisplay;
    const edges = (kind: "margin" | "padding", from: Edges): Edges => {
        const e: Edges = { top: 0, right: 0, bottom: 0, left: 0 };
        SIDES.forEach((s: Side) => {
            e[s] = pick<number>(`${kind}-${s}`, from[s], 0, (v: ParsedValue) => Number(v));
        });
        return e;
    };
    const border: Borders = { top: init.border.top, right: init.border.right, bottom: init.border.bottom, left: init.border.left };
    SIDES.forEach((s: Side) => {
        const style: BorderSide["style"] = pick<BorderSide["style"]>(`border-${s}-style`, ps.border[s].style, "none", (v: ParsedValue) => v as BorderSide["style"]);
        const width: number = pick<number>(`border-${s}-width`, ps.border[s].style === "none" ? 1 : ps.border[s].width, 1, (v: ParsedValue) => Number(v));
        const bcolor: Color = pick<Color>(`border-${s}-color`, ps.border[s].color, color, (v: ParsedValue) => colorOf(v, color));
        border[s] = { style, width: style === "none" ? 0 : width, color: bcolor };
    });
    borderGroups(run.book, border, env);
    const weight: number = pick<number>("font-weight", ps.fontWeight, 400, (v: ParsedValue) =>
        v === "bolder" ? bolder(ps.fontWeight) : v === "lighter" ? lighter(ps.fontWeight) : Number(v),
    );
    const line: DecorationLine = pick<DecorationLine>("text-decoration-line", ps.textDecoration, { underline: false, lineThrough: false, overline: false }, (v: ParsedValue) => v as DecorationLine);
    const decoColor: Color | undefined = pick<Color | undefined>("text-decoration-color", ps.textDecoration.color, undefined, (v: ParsedValue) =>
        v === "currentcolor" ? undefined : isColor(v) ? v : undefined,
    );
    const textDecoration: TextDecoration = { underline: line.underline, lineThrough: line.lineThrough, overline: line.overline };
    if (decoColor !== undefined) {
        textDecoration.color = decoColor;
    }
    const content: ContentItem[] | undefined = pick<ContentItem[] | undefined>("content", ps.content, undefined, (v: ParsedValue) => (Array.isArray(v) ? (v as ContentItem[]) : undefined));
    const counters = (lh: string, from: CounterOp[]): CounterOp[] => pick<CounterOp[]>(lh, from, [], (v: ParsedValue) => (Array.isArray(v) ? (v as CounterOp[]) : []));
    const style: ComputedStyle = {
        display,
        visibility: pick("visibility", ps.visibility, init.visibility, (v: ParsedValue) => v as ComputedStyle["visibility"]),
        margin: edges("margin", ps.margin),
        padding: edges("padding", ps.padding),
        border,
        color,
        backgroundColor: pick<Color>("background-color", ps.backgroundColor, init.backgroundColor, (v: ParsedValue) => colorOf(v, init.backgroundColor)),
        fontWeight: weight,
        fontStyle: pick("font-style", ps.fontStyle, init.fontStyle, (v: ParsedValue) => v as ComputedStyle["fontStyle"]),
        textDecoration,
        whiteSpace: pick("white-space", ps.whiteSpace, init.whiteSpace, (v: ParsedValue) => v as ComputedStyle["whiteSpace"]),
        tabSize: pick<number>("tab-size", ps.tabSize, init.tabSize, (v: ParsedValue) => Number(v)),
        textAlign: pick("text-align", ps.textAlign, init.textAlign, (v: ParsedValue) => v as ComputedStyle["textAlign"]),
        textTransform: pick("text-transform", ps.textTransform, init.textTransform, (v: ParsedValue) => v as ComputedStyle["textTransform"]),
        listStyleType: pick("list-style-type", ps.listStyleType, init.listStyleType, (v: ParsedValue) => v as ListStyleType),
        listStylePosition: pick("list-style-position", ps.listStylePosition, init.listStylePosition, (v: ParsedValue) => v as ComputedStyle["listStylePosition"]),
        order: pick<number>("order", 0, 0, (v: ParsedValue) => Number(v)),
        alignItems: pick<AlignItems>("align-items", ps.alignItems, "normal", (v: ParsedValue) => v as AlignItems),
        fill: pick<boolean>("width", false, false, (v: ParsedValue) => v === "fill"),
        content,
        counterReset: counters("counter-reset", ps.counterReset),
        counterIncrement: counters("counter-increment", ps.counterIncrement),
        counterSet: counters("counter-set", ps.counterSet),
        custom,
    };
    return { style, raw, authorColor, yielded: yields };
}

/** Presentational counter hints: `start` on a list-item counter reset, `value` on a list item. */
function counterHints(el: DomElement, style: ComputedStyle): ComputedStyle {
    const start: string | undefined = el.attrs.start;
    const value: string | undefined = el.attrs.value;
    const startN: number = start !== undefined && /^\s*[+-]?\d+\s*$/.test(start) ? parseInt(start, 10) : NaN;
    const valueN: number = value !== undefined && /^\s*[+-]?\d+\s*$/.test(value) ? parseInt(value, 10) : NaN;
    const resets: CounterOp[] = !isNaN(startN)
        ? style.counterReset.map((op: CounterOp) => (op.name === "list-item" ? { name: op.name, value: startN - 1 } : op))
        : style.counterReset;
    const sets: CounterOp[] = !isNaN(valueN) && style.display === "list-item"
        ? style.counterSet.filter((op: CounterOp) => op.name !== "list-item").concat([{ name: "list-item", value: valueN }])
        : style.counterSet;
    return resets === style.counterReset && sets === style.counterSet ? style : { ...style, counterReset: resets, counterSet: sets };
}

function contentText(run: Run, items: readonly ContentItem[], el: DomElement, scope: CounterScope): string {
    let out: string = "";
    for (const item of items) {
        const list: Counter[] = item.kind === "counter" || item.kind === "counters" ? scope.get(item.name) || [] : [];
        if (item.kind === "string") {
            out += item.text;
        } else if (item.kind === "attr") {
            out += el.attrs[item.name] || "";
        } else if (item.kind === "counter") {
            out += counterText(list.length > 0 ? list[list.length - 1].value : 0, item.style);
        } else if (item.kind === "counters") {
            out += (list.length > 0 ? list : [{ value: 0, owner: -1 }]).map((c: Counter) => counterText(c.value, item.style)).join(item.separator);
        } else if (item.kind === "open-quote") {
            out += run.quoteDepth % 2 === 0 ? "“" : "‘";
            run.quoteDepth += 1;
        } else {
            run.quoteDepth = Math.max(0, run.quoteDepth - 1);
            out += run.quoteDepth % 2 === 0 ? "”" : "’";
        }
    }
    return out;
}

/** The paint groups; a yielded UA colour is painted over by a group of the inherited colour (rule groups merge by name). */
function paintOf(run: Run, matched: readonly MatchedDeclaration[], style: ComputedStyle, yielded: boolean = false): string[] {
    const sub = (v: string): string | undefined => substitute(v, (n: string) => style.custom[n], run.env.vars);
    const names: string[] = paintFor(run.book, matched, sub, run.env, style.fontWeight);
    const inherited: string | undefined = yielded ? colorPaint(run.book, style.color, run.env) : undefined;
    return inherited !== undefined ? names.concat([inherited]) : names;
}

/** `::before` / `::after` (only with content) and `::marker` (list items; content or the list-style marker). */
function pseudo(run: Run, el: DomElement, which: PseudoElement, owner: Computed, scope: CounterScope): StyledPseudo | undefined {
    const matched: MatchedDeclaration[] = matchRules(run.ctx, el, which);
    const c: Computed = cascade(run, matched, owner, FLEX_OR_GRID.has(owner.raw));
    const isMarker: boolean = which === "marker";
    const shown: boolean = isMarker ? owner.style.display === "list-item" : c.style.content !== undefined && c.style.display !== "none";
    let out: StyledPseudo | undefined;
    if (shown) {
        applyCounters(scope, c.style, el.id, false);
        const list: Counter[] = scope.get("list-item") || [];
        const n: number = list.length > 0 ? list[list.length - 1].value : 0;
        const text: string = c.style.content !== undefined ? contentText(run, c.style.content, el, scope) : markerText(n, owner.style.listStyleType);
        out = isMarker && text.length === 0 ? undefined : { kind: "pseudo", pseudo: which, style: c.style, paint: paintOf(run, matched, c.style), text };
    }
    return out;
}

function element(run: Run, el: DomElement, parent: Computed | undefined, scope: CounterScope, owner: number): StyledElement {
    const matched: MatchedDeclaration[] = matchRules(run.ctx, el);
    const blockifyIt: boolean = parent === undefined || FLEX_OR_GRID.has(parent.raw);
    const c0: Computed = cascade(run, matched, parent, blockifyIt);
    const c: Computed = { style: counterHints(el, c0.style), raw: c0.raw, authorColor: c0.authorColor, yielded: c0.yielded };
    applyCounters(scope, c.style, owner, c.style.display === "list-item");
    const marker: StyledPseudo | undefined = pseudo(run, el, "marker", c, copyScope(scope));
    const inner: CounterScope = copyScope(scope);
    const before: StyledPseudo | undefined = pseudo(run, el, "before", c, inner);
    const children: StyledNode[] = el.children.map((child: DomNode): StyledNode =>
        child.type === "text" ? { kind: "text", text: child.text, id: child.id } : element(run, child, c, inner, el.id),
    );
    const after: StyledPseudo | undefined = pseudo(run, el, "after", c, inner);
    const out: StyledElement = { kind: "element", element: el, style: c.style, paint: paintOf(run, matched, c.style, c.yielded), children };
    if (before !== undefined) {
        out.before = before;
    }
    if (after !== undefined) {
        out.after = after;
    }
    if (marker !== undefined) {
        out.marker = marker;
    }
    return out;
}

/** True for a selector that is exactly one `.hljs-*` class (a code-token rule: no element ever matches it). */
function isTokenSelector(selector: ComplexSelector): boolean {
    const only: CompoundSelector | undefined = selector.compounds.length === 1 && selector.pseudo === undefined ? selector.compounds[0] : undefined;
    return only !== undefined && only.simples.length === 1 && only.simples[0].kind === "class" && only.simples[0].name.startsWith("hljs-");
}

/**
 * Registers the groups of the sheets' `.hljs-*` rules independent of element matching: the highlighter marks code
 * tokens with these classes after layout, so no element of the tree ever matches them. Values are substituted with the
 * root's custom properties.
 */
function tokenGroups(run: Run, root: StyledElement): void {
    const matched: MatchedDeclaration[] = [];
    for (const sheet of run.ctx.sheets) {
        for (const rule of sheet.rules) {
            for (const selector of rule.selectors.filter(isTokenSelector)) {
                for (const declaration of rule.declarations) {
                    matched.push({ declaration, origin: sheet.origin, specificity: selector.specificity, order: rule.order, selector });
                }
            }
        }
    }
    const sub = (v: string): string | undefined => substitute(v, (n: string) => root.style.custom[n], run.env.vars);
    paintFor(run.book, matched.sort(compareCascade), sub, run.env, root.style.fontWeight);
}

/** {@link import("./index").computeStyles} with explicit dependencies. */
export function computeStyles(doc: DomDocument, sheets: readonly ParsedSheet[], env: StyleEnv, state: FormState): StyledTree {
    const themed: DomDocument = withBodyClass(doc, "vscode-" + env.themeKind);
    const first: number = nextOrder(sheets, 0);
    const docSheets: ParsedSheet[] = [];
    themed.styles.forEach((text: string, i: number) => {
        docSheets.push(parseSheet(text, "author", `<style>#${i + 1}`, nextOrder(docSheets, first)));
    });
    const ctx: MatchContext = { doc: themed, sheets: sheets.concat(docSheets), checked: (el: DomElement) => isChecked(themed, state, el) };
    const run: Run = { ctx, env, book: newBook(), quoteDepth: 0 };
    const root: StyledElement = element(run, themed.root, undefined, new Map<string, Counter[]>(), -1);
    tokenGroups(run, root);
    return { root, groups: hostGroupDefs(env).concat([...run.book.rules.values()]) };
}
