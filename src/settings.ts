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

/** The levels of `htmlview.stylesheets` that count (coc's `inspect()`); the default level is ignored on purpose. */
export interface SheetLevels {
    globalValue?: unknown;
    workspaceValue?: unknown;
    workspaceFolderValue?: unknown;
}

/** Where relative paths of each level resolve: the user's coc config folder and the workspace root. */
export interface SettingRoots {
    user: string;
    workspace: string;
}

function pathList(value: unknown): string[] {
    return (Array.isArray(value) ? value : []).filter((f: unknown): f is string => typeof f === "string" && f !== "");
}

/**
 * The user's stylesheets: the user level (relative paths against the coc config folder), then the workspace level
 * (against the workspace root), each expanded first. The default level, where other extensions' manifests would land,
 * is not read: extensions style their own views through `render()`.
 */
export function settingSheets(levels: SheetLevels | undefined, roots: SettingRoots, expand: (file: string) => string): string[] {
    const user: string[] = pathList(levels?.globalValue).map((f: string): string => resolveSheetPath(expand(f), roots.user));
    const workspace: string[] = pathList(levels?.workspaceFolderValue ?? levels?.workspaceValue).map((f: string): string => resolveSheetPath(expand(f), roots.workspace));
    return [...user, ...workspace];
}

/** The effective settings. */
export interface Settings {
    mode: "split" | "float";
    splitCommand: string;
    stylesheets: string[];
    linkTargets: boolean;
}

let warned = false;

/**
 * Reads `htmlview.view.mode`, `htmlview.view.splitCommand`, `htmlview.stylesheets` ({@link settingSheets}, with
 * `userRoot` the coc config folder) and `htmlview.linkTargets`.
 */
export function readSettings(coc: typeof Coc, userRoot: string): Settings {
    const config = coc.workspace.getConfiguration("htmlview");
    const rawMode: string = config.get<string>("view.mode", "float");
    const rawSplit: string = config.get<string>("view.splitCommand", DEFAULT_SPLIT_COMMAND);
    const rawTargets: unknown = config.get<unknown>("linkTargets", false);
    let splitCommand: string = rawSplit;
    if (!isSplitCommand(rawSplit)) {
        splitCommand = DEFAULT_SPLIT_COMMAND;
        if (!warned) {
            warned = true;
            void coc.window.showWarningMessage(`coc-htmlview: htmlview.view.splitCommand: '${rawSplit}' is not a split command, using '${DEFAULT_SPLIT_COMMAND}'`);
        }
    }
    const roots: SettingRoots = { user: userRoot, workspace: coc.workspace.root };
    const sheets: string[] = settingSheets(config.inspect<unknown>("stylesheets"), roots, (f: string): string => coc.workspace.expand(f));
    return { mode: rawMode === "split" ? "split" : "float", splitCommand, stylesheets: sheets, linkTargets: rawTargets === true };
}

/**
 * The pipeline options of a `render()` call under the settings: mode and split command default to the settings, the
 * user's stylesheets come first (a base the caller's sheets override), the caller's paths are expanded and resolved
 * against its `root` (default `defaultRoot`, coc-htmlview's own folder) and link targets follow the setting.
 */
export function applySettings(options: ApiRenderOptions, s: Settings, defaultRoot: string, expand: (file: string) => string): RenderOptions {
    const { root, ...rest } = options;
    const base: string = root !== undefined && root !== "" ? root : defaultRoot;
    const own: string[] = pathList(options.stylesheets).map((f: string): string => resolveSheetPath(expand(f), base));
    return {
        ...rest,
        stylesheets: [...s.stylesheets, ...own],
        linkTargets: s.linkTargets,
        view: { ...options.view, mode: options.view.mode ?? s.mode, splitCommand: options.view.splitCommand ?? s.splitCommand }
    };
}
