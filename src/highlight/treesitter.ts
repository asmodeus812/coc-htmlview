/**
 * The TS side of the treesitter pass: builds the job list and makes the single batched `nvim.lua` call that runs
 * {@link TREESITTER_LUA}. Never throws.
 */
import type { Neovim } from "coc.nvim";
import { MarkPriority } from "../common";
import type { CodeRegion } from "../types";
import type { LanguageTable, TreesitterResult } from "./index";
import { resolveLanguage } from "./languages";
import TREESITTER_LUA from "./treesitter.lua";

/** One region as the Lua chunk receives it. */
export interface TreesitterJob {
    /** Index into the caller's regions array (what `handled` reports). */
    index: number;
    /** Treesitter language name. */
    lang: string;
    text: string;
    startLine: number;
    /** Display cells; the Lua side converts to bytes per buffer line. */
    startCol: number;
}

/** Jobs for the regions whose language names a treesitter parser; the others are left to hljs. */
export function buildJobs(regions: CodeRegion[], languages: LanguageTable): TreesitterJob[] {
    const jobs: TreesitterJob[] = [];
    regions.forEach((region: CodeRegion, index: number) => {
        const lang = resolveLanguage(region.lang, languages).treesitter;
        if (lang !== undefined && lang !== "") {
            jobs.push({ index, lang, text: region.text, startLine: region.startLine, startCol: region.startCol });
        }
    });
    return jobs;
}

/** The `nvim.lua` argument list: `[bufnr, ns, priority, jobs]`. */
export function luaArgs(bufnr: number, ns: number, jobs: TreesitterJob[]): [number, number, number, TreesitterJob[]] {
    return [bufnr, ns, MarkPriority.code, jobs];
}

/** Keeps the integer indexes the Lua side reported that belong to a sent job. */
function toHandled(result: unknown, jobs: TreesitterJob[]): number[] {
    const sent = new Set<number>(jobs.map((job: TreesitterJob) => job.index));
    const raw: unknown[] = Array.isArray(result) ? result : [];
    return raw.filter((value: unknown): value is number => typeof value === "number" && sent.has(value));
}

/** See `treesitterRegions` in `./index`. */
export async function runTreesitter(
    nvim: Neovim,
    bufnr: number,
    ns: number,
    regions: CodeRegion[],
    languages: LanguageTable
): Promise<TreesitterResult> {
    let handled: number[] = [];
    try {
        const jobs = buildJobs(regions, languages);
        if (jobs.length > 0) {
            const args = luaArgs(bufnr, ns, jobs) as unknown as Parameters<Neovim["lua"]>[1];
            handled = toHandled(await nvim.lua(TREESITTER_LUA, args), jobs);
        }
    } catch {
        handled = [];
    }
    return { handled };
}
