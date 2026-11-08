/**
 * Highlight groups of the style part (private to style/): the host role and variable groups (`host.ts`), and
 * the rule groups `HtmlView<Pascal(selector)>` / `HtmlViewInline<hash>` that an element's `paint` lists.
 * A rule group carries THAT RULE's visual declarations; an element paints with its matching rule groups in
 * cascade order (lowest first). Pure; the book is a per-run value, never module state.
 */
import type { MatchedDeclaration } from "../css";
import type { ColorRef, GroupDef } from "../../types";
import type { Color, StyleEnv } from "./index";
import { groupName } from "./index";
import { hostRoles } from "./host";
import type { HostRole, HostRoleEntry } from "./host";
import { expandDeclaration, parseValue } from "./properties";
import type { DecorationLine, ParsedValue } from "./properties";
import { wideKeyword } from "./values";

/** The groups collected during one {@link computeStyles} run. */
export interface GroupBook {
    /** Rule and inline groups by name, in first-use order. */
    rules: Map<string, GroupDef>;
    /** Rule keys (`order|selector`) already merged into their group. */
    seen: Set<string>;
}

/** A fresh book. */
export function newBook(): GroupBook {
    return { rules: new Map<string, GroupDef>(), seen: new Set<string>() };
}

/** Role groups (`hi def link` + fallback chain) then one group per host variable (linked to its role group). */
export function hostGroupDefs(env: StyleEnv): GroupDef[] {
    const roles: GroupDef[] = (Object.keys(hostRoles) as HostRole[]).map((r: HostRole): GroupDef => {
        const entry: HostRoleEntry = hostRoles[r];
        const def: GroupDef = { name: entry.group, link: entry.links[0], fallback: entry.links.slice(1) };
        return entry.fgOnly === true ? { ...def, only: "fg" } : def;
    });
    const vars: GroupDef[] = Object.keys(env.vars)
        .sort()
        .map((v: string): GroupDef => ({ name: groupName(v), link: hostRoles[env.vars[v].role].group }));
    return roles.concat(vars);
}

/** A computed colour as a group definition carries it (variables through their group, with the native chain). */
function groupColor(color: Color, env: StyleEnv): ColorRef | undefined {
    let out: ColorRef | undefined;
    if ("hex" in color) {
        out = color.alpha >= 1 ? { hex: color.hex } : { hex: color.hex, alpha: color.alpha };
    } else if ("var" in color && env.vars[color.var] !== undefined) {
        out = { group: groupName(color.var), attr: color.attr, fallback: hostRoles[env.vars[color.var].role].links.slice() };
    } else if ("group" in color) {
        out = { group: color.group, attr: color.attr };
    }
    return out;
}

function fnv1a(text: string): string {
    let h: number = 0x811c9dc5;
    for (let i: number = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
}

type Visual = Omit<GroupDef, "name">;

function applyColor(def: Visual, key: "fg" | "bg" | "sp", parsed: ParsedValue | undefined, env: StyleEnv): void {
    const color: ColorRef | undefined = parsed !== undefined && parsed !== null && typeof parsed === "object" && ("hex" in parsed || "var" in parsed || "group" in parsed)
        ? groupColor(parsed as Color, env)
        : undefined;
    if (color !== undefined) {
        def[key] = color;
    }
}

/**
 * The visual part of a set of declarations (already var()-substituted): colours, bold (weight ≥ 600, explicit
 * `false` below), italic, underline and strikethrough. `bolder`/`lighter` use `weight` (the element's computed
 * weight). Wide keywords and `currentcolor` leave the attribute to the outer marks.
 */
function visualOf(decls: ReadonlyArray<[string, string]>, env: StyleEnv, weight: number): Visual {
    const def: Visual = {};
    for (const [property, value] of decls) {
        for (const [lh, v] of expandDeclaration(property, value, env.vars) || []) {
            const parsed: ParsedValue | undefined = wideKeyword(v) === undefined ? parseValue(lh, v, env.vars) : undefined;
            if (lh === "color") {
                applyColor(def, "fg", parsed, env);
            } else if (lh === "background-color") {
                applyColor(def, "bg", parsed, env);
            } else if (lh === "text-decoration-color") {
                applyColor(def, "sp", parsed, env);
            } else if (lh === "font-weight" && parsed !== undefined) {
                def.bold = (typeof parsed === "number" ? parsed : weight) >= 600;
            } else if (lh === "font-style" && parsed !== undefined) {
                def.italic = parsed === "italic";
            } else if (lh === "text-decoration-line" && parsed !== undefined && parsed !== null && typeof parsed === "object") {
                def.underline = (parsed as DecorationLine).underline;
                def.strikethrough = (parsed as DecorationLine).lineThrough;
            }
        }
    }
    return def;
}

function isEmpty(def: Visual): boolean {
    return Object.keys(def).length === 0;
}

/** Registers `name` with `def`, merging over an earlier rule of the same selector text (later attributes win). */
function register(book: GroupBook, key: string, name: string, def: Visual): void {
    const prev: GroupDef | undefined = book.rules.get(name);
    if (!book.seen.has(key)) {
        book.seen.add(key);
        book.rules.set(name, prev !== undefined ? { ...prev, ...def, name } : { name, ...def });
    }
}

/** One matching rule (or the inline style) of an element, while its paint groups are collected. */
interface RuleEntry {
    key: string;
    name: string;
    inline: boolean;
    decls: Array<[string, string]>;
    /** Index of its highest-precedence matched declaration. */
    last: number;
}

/**
 * The paint groups of one element (or pseudo-element) from its matched declarations (sorted, lowest first):
 * one group per matching rule (keyed by rule order and selector text) or inline style with visual declarations,
 * ordered by the rule's highest-precedence declaration, duplicates (same name) keeping the last position.
 * `sub` substitutes var() with the element's custom properties.
 */
export function paintFor(
    book: GroupBook,
    matched: readonly MatchedDeclaration[],
    sub: (value: string) => string | undefined,
    env: StyleEnv,
    weight: number,
): string[] {
    const rules: Map<string, RuleEntry> = new Map<string, RuleEntry>();
    matched.forEach((m: MatchedDeclaration, i: number) => {
        const key: string = m.selector !== undefined ? `${m.order}|${m.selector.text}` : "inline";
        const entry: RuleEntry = rules.get(key) || { key, name: m.selector !== undefined ? groupName(m.selector.text) : "", inline: m.selector === undefined, decls: [], last: i };
        const value: string | undefined = m.declaration.property.startsWith("--") ? undefined : sub(m.declaration.value);
        if (value !== undefined) {
            entry.decls.push([m.declaration.property, value]);
        }
        entry.last = i;
        rules.set(key, entry);
    });
    const ordered: RuleEntry[] = [...rules.values()].sort((a: RuleEntry, b: RuleEntry) => a.last - b.last);
    const names: string[] = [];
    for (const rule of ordered) {
        const def: Visual = visualOf(rule.decls, env, weight);
        const name: string = rule.inline ? "HtmlViewInline" + fnv1a(JSON.stringify(def)) : rule.name;
        if (!isEmpty(def) && name !== "HtmlView") {
            register(book, rule.inline ? name : rule.key, name, def);
            const at: number = names.indexOf(name);
            if (at >= 0) {
                names.splice(at, 1);
            }
            names.push(name);
        }
    }
    return names;
}
