/**
 * Syntax highlighting of {@link CodeRegion}s. Two engines, chosen per region:
 * 1. treesitter (Neovim only, Lua side, via the view's buffer) when the language table names a parser that is
 *    installed;
 * 2. highlight.js (pure, here) for every region treesitter did not handle (no parser, or Vim).
 *
 * hljs tokens become marks with the group of their `hljs-*` class through the StyleMap (`groupForClass`), so
 * a stylesheet can style them with `.hljs-*` rules; nested scopes produce nested marks (inner wins by priority).
 */
import type { Neovim } from "coc.nvim";
import type { CodeRegion, Mark } from "../types";
import { hljsRegions } from "./hljs";
import { LANGUAGES, buildLanguageTable } from "./languages";
import { runTreesitter } from "./treesitter";

import type { LanguageEntry, LanguageOptions } from "../api";

export type { LanguageEntry, LanguageOptions } from "../api";

/** Language name (`"java"`, `"ts"`, `"sh"`, …) → engine ids. Unknown names use the name itself for both. */
export type LanguageTable = Record<string, LanguageEntry>;

/** Result of the treesitter pass. */
export interface TreesitterResult {
    /** Indexes (into the given regions array) that treesitter highlighted; the rest go to hljs. */
    handled: number[];
}

/**
 * The highlighter the view drives after the buffer is filled. Created by {@link createHighlighter}; holds no
 * mutable state.
 */
export interface CodeHighlighter {
    /** Pure hljs pass; same contract as {@link highlightRegions}. */
    hljs(regions: CodeRegion[]): Mark[];
    /** Treesitter pass on the live buffer; same contract as {@link treesitterRegions}. */
    treesitter(nvim: Neovim, bufnr: number, ns: number, regions: CodeRegion[]): Promise<TreesitterResult>;
}

/**
 * The default language table: the common code-block language names and aliases (markdown fence / GitHub linguist
 * style) with their treesitter parser and highlight.js names.
 */
export const defaultLanguageTable: Readonly<LanguageTable> = LANGUAGES;

export { buildLanguageTable };

/**
 * hljs pass. Returns marks in layout coordinates (0-based lines, display-cell columns: the region's `startLine`
 * and `startCol` added, cells measured with `common.displayWidth`), priority `MarkPriority.code + scope depth`,
 * group = `groupForClass(tokenClass)`; tokens whose class has no group are skipped. A region whose language hljs
 * does not know yields no marks (no auto-detection). Pure.
 */
export function highlightRegions(
    regions: CodeRegion[],
    languages: LanguageTable,
    groupForClass: (cls: string) => string | undefined
): Mark[] {
    return hljsRegions(regions, languages, groupForClass);
}

/**
 * Treesitter pass (Neovim only; resolves to `{handled: []}` on Vim or on any error). For each region whose language
 * maps to an installed parser, parses `region.text` with a string parser on the Lua side and sets extmarks in `ns`
 * on `bufnr` with the capture groups (`@keyword.java`, …), converting to byte columns on the Lua side, priority
 * `MarkPriority.code`. Never touches lines outside the regions.
 */
export async function treesitterRegions(
    nvim: Neovim,
    bufnr: number,
    ns: number,
    regions: CodeRegion[],
    languages: LanguageTable
): Promise<TreesitterResult> {
    return runTreesitter(nvim, bufnr, ns, regions, languages);
}

/** Binds a language table and a class→group lookup (usually `styleMap.groupForClass`) into a CodeHighlighter. */
export function createHighlighter(
    languages: LanguageTable,
    groupForClass: (cls: string) => string | undefined
): CodeHighlighter {
    return {
        hljs: (regions: CodeRegion[]): Mark[] => highlightRegions(regions, languages, groupForClass),
        treesitter: (nvim: Neovim, bufnr: number, ns: number, regions: CodeRegion[]): Promise<TreesitterResult> =>
            treesitterRegions(nvim, bufnr, ns, regions, languages),
    };
}
