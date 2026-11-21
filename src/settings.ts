/**
 * The `htmlview.*` settings: pure helpers (no coc dependency, unit-testable) and `readSettings`, which reads them
 * from a coc module passed in.
 */
import * as path from "path";
import type * as Coc from "coc.nvim";
import type { RenderOptions as ApiRenderOptions } from "./api";
import type { RenderOptions } from "./render";

export const DEFAULT_SPLIT_COMMAND = "botright vsplit";

/** `head` with its optional `tail`, e.g. abbrev("vert", "ical") matches vert, verti, ... vertical. */
function abbrev(head: string, tail: string): string {
    return head + tail.split("").reduceRight((rest: string, c: string): string => `(?:${c}${rest})?`, "");
}

const MODIFIERS: string = [
    abbrev("vert", "ical"),
    abbrev("lefta", "bove"),
    abbrev("abo", "veleft"),
    abbrev("rightb", "elow"),
    abbrev("bel", "owright"),
    abbrev("to", "pleft"),
    abbrev("bo", "tright"),
    "tab"
].join("|");
const COMMANDS: string = [abbrev("sp", "lit"), abbrev("vs", "plit"), "new", abbrev("vne", "w")].join("|");
const SPLIT_LIKE: RegExp = new RegExp(`^(?:(?:\\d+\\s*)?(?:${MODIFIERS})\\s+)*(?:\\d+\\s*)?(?:${COMMANDS})$`);

/** Whether `command` is only split modifiers (and counts) followed by split/vsplit/new/vnew (or abbreviations). */
export function isSplitCommand(command: string): boolean {
    return SPLIT_LIKE.test(command.trim());
}

/** Makes a (already `workspace.expand`ed) stylesheet path absolute, relative ones against `root`. */
export function resolveSheetPath(file: string, root: string): string {
    return path.isAbsolute(file) || root === "" ? file : path.resolve(root, file);
}

/** The effective settings. */
export interface Settings {
    mode: "split" | "float";
    splitCommand: string;
    stylesheets: string[];
    linkTargets: boolean;
}

let warned = false;

/** Reads `htmlview.view.mode`, `htmlview.view.splitCommand`, `htmlview.stylesheets` (expanded, absolute) and `htmlview.linkTargets`. */
export function readSettings(coc: typeof Coc): Settings {
    const config = coc.workspace.getConfiguration("htmlview");
    const rawMode: string = config.get<string>("view.mode", "float");
    const rawSplit: string = config.get<string>("view.splitCommand", DEFAULT_SPLIT_COMMAND);
    const rawSheets: unknown = config.get<unknown>("stylesheets", []);
    const rawTargets: unknown = config.get<unknown>("linkTargets", false);
    let splitCommand: string = rawSplit;
    if (!isSplitCommand(rawSplit)) {
        splitCommand = DEFAULT_SPLIT_COMMAND;
        if (!warned) {
            warned = true;
            void coc.window.showWarningMessage(`coc-htmlview: htmlview.view.splitCommand: '${rawSplit}' is not a split command, using '${DEFAULT_SPLIT_COMMAND}'`);
        }
    }
    const sheets: string[] = (Array.isArray(rawSheets) ? rawSheets : [])
        .filter((f: unknown): f is string => typeof f === "string" && f !== "")
        .map((f: string): string => resolveSheetPath(coc.workspace.expand(f), coc.workspace.root));
    return { mode: rawMode === "split" ? "split" : "float", splitCommand, stylesheets: sheets, linkTargets: rawTargets === true };
}

/**
 * The pipeline options of a `render()` call under the settings: mode and split command default to the settings, the
 * user's stylesheets come first (a base the caller's sheets override) and link targets follow the setting.
 */
export function applySettings(options: ApiRenderOptions, s: Settings): RenderOptions {
    return {
        ...options,
        stylesheets: [...s.stylesheets, ...(options.stylesheets ?? [])],
        linkTargets: s.linkTargets,
        view: { ...options.view, mode: options.view.mode ?? s.mode, splitCommand: options.view.splitCommand ?? s.splitCommand }
    };
}
