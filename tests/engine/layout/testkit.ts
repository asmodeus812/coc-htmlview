/**
 * Test helpers of the box engine: hand-built StyledTree fixtures (no dom/css/style needed) and the Layout
 * invariant checker. Test-only; not imported by runtime code.
 */
import { displayWidth } from "../../../src/common";
import type { DomElement } from "../../../src/engine/dom";
import type { BorderSide, ComputedStyle, StyledElement, StyledNode, StyledPseudo, StyledText, StyledTree } from "../../../src/engine/style";
import { initialStyle } from "../../../src/engine/style";
import type { Layout } from "../../../src/types";
import { sliceCells } from "../../../src/engine/layout/emit";
import { layoutBoxes } from "../../../src/engine/layout/index";
import type { LayoutOptions } from "../../../src/engine/layout/index";
import * as assert from "node:assert/strict";

/** Element fixture options. */
export interface ElOpts {
    attrs?: Record<string, string>;
    paint?: string[];
    before?: string;
    after?: string;
    /** `::marker` text (omit to let layout compute it from list-style-type). */
    marker?: string;
}

/** A fixture builder; ids are allocated per kit (no shared state). */
export interface Kit {
    el(tag: string, style: Partial<ComputedStyle>, children?: Array<StyledNode | string>, opts?: ElOpts): StyledElement;
    tree(root: StyledElement): StyledTree;
}

/** A solid one-cell border side. */
export function solid(style: BorderSide["style"] = "solid"): BorderSide {
    return { style, width: 1, color: { var: "--vscode-border", attr: "fg" } };
}

/** All four sides. */
export function box4(side: BorderSide): ComputedStyle["border"] {
    return { top: side, right: side, bottom: side, left: side };
}

/** Edges helper (top, right, bottom, left). */
export function edges(top: number, right: number = top, bottom: number = top, left: number = right): ComputedStyle["margin"] {
    return { top, right, bottom, left };
}

/** A new kit. */
export function kit(): Kit {
    let next: number = 0;
    const pseudo = (kind: StyledPseudo["pseudo"], text: string, parent: ComputedStyle): StyledPseudo => ({
        kind: "pseudo",
        pseudo: kind,
        style: { ...initialStyle(), color: parent.color, whiteSpace: parent.whiteSpace },
        paint: [`P${kind}`],
        text,
    });
    const el = (tag: string, style: Partial<ComputedStyle>, children: Array<StyledNode | string> = [], opts: ElOpts = {}): StyledElement => {
        const id: number = next++;
        const full: ComputedStyle = { ...initialStyle(), ...style };
        const kids: StyledNode[] = children.map((c: StyledNode | string): StyledNode => (typeof c === "string" ? ({ kind: "text", text: c, id: next++ } as StyledText) : c));
        const attrs: Record<string, string> = opts.attrs ?? {};
        const element: DomElement = { type: "element", id, tag, attrs, classList: (attrs.class ?? "").split(/\s+/).filter((c: string): boolean => c !== ""), children: [] };
        return {
            kind: "element",
            element,
            style: full,
            paint: opts.paint ?? [],
            before: opts.before !== undefined ? pseudo("before", opts.before, full) : undefined,
            after: opts.after !== undefined ? pseudo("after", opts.after, full) : undefined,
            marker: opts.marker !== undefined ? pseudo("marker", opts.marker, full) : undefined,
            children: kids,
        };
    };
    return { el, tree: (root: StyledElement): StyledTree => ({ root, groups: [] }) };
}

/** Common display shortcuts. */
export const B: Partial<ComputedStyle> = { display: "block" };
export const I: Partial<ComputedStyle> = { display: "inline" };

/** Checks the Layout invariants; returns the violations (empty = ok). */
export function violations(out: Layout): string[] {
    const errs: string[] = [];
    const inCode = (line: number): boolean => out.codeRegions.some((r) => line >= r.startLine && line <= r.endLine);
    // A background block pads its lines to its right edge: trailing spaces are kept only under a mark reaching the end.
    const tinted = (line: number, width: number): boolean => out.marks.some((m) => m.line === line && m.endCol >= width && m.startCol < width);
    out.lines.forEach((line: string, i: number): void => {
        if (/[\t\n]/.test(line)) {
            errs.push("tab/newline on line " + i);
        }
        if (/ $/.test(line) && !inCode(i) && !tinted(i, displayWidth(line))) {
            errs.push("trailing space on line " + i + ": " + JSON.stringify(line));
        }
    });
    const within = (kind: string, r: { line: number; startCol: number; endCol: number }): void => {
        const line: string | undefined = out.lines[r.line];
        if (line === undefined || r.startCol < 0 || r.startCol >= r.endCol || r.endCol > displayWidth(line)) {
            errs.push(kind + " out of range " + JSON.stringify(r) + " on " + JSON.stringify(line));
        }
    };
    out.marks.filter((m) => !m.lineHl).forEach((m) => within("mark", m));
    out.links.forEach((l) => within("link", l));
    out.codeRegions.forEach((r) => {
        r.text.split("\n").forEach((codeLine: string, k: number): void => {
            const bufLine: string = out.lines[r.startLine + k] ?? "";
            const slice: string = sliceCells(bufLine, r.startCol, r.startCol + displayWidth(codeLine));
            if (slice !== codeLine) {
                errs.push("region text mismatch line " + (r.startLine + k) + ": " + JSON.stringify(slice) + " vs " + JSON.stringify(codeLine));
            }
        });
    });
    (out.virtText ?? []).forEach((v) => {
        const line: string | undefined = out.lines[v.line];
        if (line === undefined || v.col < 0 || v.col > displayWidth(line) || (v.pos === "overlay" && v.col >= displayWidth(line))) {
            errs.push("virtText out of range " + JSON.stringify(v));
        }
    });
    return errs;
}

/** An `html > body` root holding `children`. */
export function docRoot(k: Kit, children: StyledElement[]): StyledElement {
    return k.el("html", B, [k.el("body", B, children)]);
}

/** Lays out `root` (width 40, tabstop 4 unless overridden) and asserts the Layout invariants. */
export function layOut(root: StyledElement, k: Kit, opts: Partial<LayoutOptions> = {}): Layout {
    const out: Layout = layoutBoxes(k.tree(root), { width: 40, tabstop: 4, ...opts });
    assert.deepEqual(violations(out), []);
    return out;
}
