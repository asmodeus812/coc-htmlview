/**
 * The editor operations a view needs, implemented once for Neovim (Lua module) and once for Vim (fallback), plus
 * the event channel both use (`CocAutocmd` notifications named `HtmlviewEvent`, filtered by the view token).
 */
import type { Neovim } from "coc.nvim";
import type { KeyAction } from "./index";
import type { Decorations, ExtmarkTuple, HlSpec } from "./convert";

/** Window/theme state: window id (-1 hidden), text width in cells, `&background`. */
export interface WinState {
    winid: number;
    width: number;
    background: string;
}

/** What `open` of a backend returns. */
export interface Opened extends WinState {
    bufnr: number;
}

/** Options a backend opens with (ViewOptions with defaults applied). */
export interface OpenSpec {
    name: string;
    reuse: boolean;
    mode: "split" | "float";
    splitCommand: string;
    floatWidth: number;
    floatHeight: number;
    title: string;
    token: string;
    keys: Array<[string, KeyAction]>;
}

/** Editor operations; every method is one (or a few) round trips. */
export interface Backend {
    open(spec: OpenSpec): Promise<Opened>;
    state(bufnr: number): Promise<WinState>;
    /** Writes the lines, defines the groups places the marks and the virtual text, lines and conceals (clearing both namespaces first). */
    write(bufnr: number, lines: string[], specs: HlSpec[], marks: ExtmarkTuple[], decor: Decorations): Promise<void>;
    /** Places code-token marks (after the treesitter pass). */
    codeMarks(bufnr: number, marks: ExtmarkTuple[]): Promise<void>;
    /** True on Neovim (treesitter and extmarks available). */
    readonly isNvim: boolean;
    /** Namespace of code-token marks (`htmlview-code`); -1 on Vim. */
    readonly codeNs: number;
    cursor(bufnr: number, line: number, col: number): Promise<void>;
    openUrl(href: string): Promise<void>;
    close(bufnr: number): Promise<void>;
}

/** An event from the editor. */
export interface ViewEvent {
    token: string;
    kind: "closed" | "resize" | "colorscheme" | "win" | "key";
    winid?: number;
    width?: number;
    background?: string;
    action?: KeyAction;
    line?: number;
    col?: number;
}

interface NotificationSource {
    on(event: "notification", fn: (method: string, args: unknown[]) => void): unknown;
    removeListener(event: "notification", fn: (method: string, args: unknown[]) => void): unknown;
}

/** Subscribes to the view events of `token`; returns the unsubscribe function. */
export function subscribe(nvim: Neovim, token: string, handler: (ev: ViewEvent) => void): () => void {
    const source = nvim as unknown as NotificationSource;
    const listener = (method: string, args: unknown[]): void => {
        const ev = Array.isArray(args) ? (args[1] as ViewEvent | undefined) : undefined;
        if (method === "CocAutocmd" && args[0] === "HtmlviewEvent" && ev !== undefined && ev.token === token) {
            handler(ev);
        }
    };
    source.on("notification", listener);
    return () => {
        source.removeListener("notification", listener);
    };
}

/** A fresh view token (unique enough per editor session). */
export function newToken(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
