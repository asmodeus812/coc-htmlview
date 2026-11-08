/**
 * Buffer and window: shows a {@link Layout}, applies marks/groups, drives the highlighter, handles keys, resize
 * and ColorScheme. The only part (with highlight's treesitter half) that talks to nvim.
 *
 * Buffer: named (`opts.name`), `buftype=nofile`, `bufhidden=hide`, `swapfile` off, `nomodifiable` (made modifiable
 * only while writing), `filetype=htmlview`; window `wrap` off (layout already wrapped), `conceallevel=0`. Marks go
 * in one namespace `htmlview` (code tokens in `htmlview-code`), columns converted with `common.cellToByte`.
 * Vim fallback: text plus `prop_add` text properties for marks; no treesitter, no line_hl (diff lines use a
 * full-line text property instead).
 */
import type { Neovim } from "coc.nvim";
import type { Layout, LinkTarget } from "../types";
import type { GroupDef, ThemeKind } from "../types";
import type { CodeHighlighter } from "../highlight";
import { newToken } from "./backend";
import { createView, openSpec } from "./controller";
import { themeKindOf } from "./keys";
import { createNvimBackend } from "./nvim";
import { createVimBackend } from "./vim";

/** Why the view asks for a new layout. */
export interface RefreshRequest {
    /**
     * `open`: first fill after the window exists; `resize`: window width changed; `context`: a context was
     * selected; `colorscheme`: ColorScheme fired or 'background' was set.
     */
    reason: "open" | "resize" | "context" | "colorscheme";
    /** Current text width of the window in cells. */
    width: number;
    /** Current context selection (ContextsNode.key → ContextNode.key), already updated for `context`. */
    selected: Record<string, string>;
    /** Theme kind read from `&background` now (may differ after `colorscheme`). */
    themeKind: ThemeKind;
    /** The link target of the activated context label or `]c`/`[c` move; set for reason `context`. */
    target?: LinkTarget;
    /** True on Neovim: layout may emit virtual text instead of buffer text. */
    virtual: boolean;
}

/** What a refresh hook returns: the layout to show and the groups it uses (StyleMap.groups, var links first). */
export interface RefreshResult {
    layout: Layout;
    /** Groups to (re)define before the marks are placed. Names are theme-independent; definitions are not. */
    groups: GroupDef[];
    /** The checked radio of every group (ContextsNode.key to ContextNode.key); the view keeps it for `]c`/`[c`. */
    selected?: Record<string, string>;
}

/**
 * Produces the content for the current window (owned by index.ts: re-runs style and layout on the kept IR). The
 * view calls it once on open (it is the only way content gets in, because the width is known only once the
 * window exists) and again on every resize / context selection / ColorScheme.
 */
export type RefreshHook = (req: RefreshRequest) => RefreshResult | Promise<RefreshResult>;

/**
 * Buffer-local key bindings, as `{lhs: action}`. Defaults: `q` close, `<CR>` follow link under cursor, `<Tab>` /
 * `<S-Tab>` next/previous link, `]]` / `[[` next/previous anchor, `gx` open URL, `]c` / `[c` next/previous context
 * of the contexts block under (or above) the cursor. `false` removes a default.
 */
export type KeyAction =
    | "close"
    | "follow"
    | "nextLink"
    | "prevLink"
    | "nextAnchor"
    | "prevAnchor"
    | "openUrl"
    | "nextContext"
    | "prevContext";

/** Key map override; merged over the defaults. */
export type KeyMap = Record<string, KeyAction | false>;

/** Options of {@link open}. */
export interface ViewOptions {
    /** `split`: a window split (`splitCommand`); `float`: a centred floating window. */
    mode: "split" | "float";
    /** Buffer name (`htmlview://rule/java:S2077`); also the reuse key. */
    name: string;
    /** Reuse the buffer (and its window if visible) of the same `name` instead of creating another. */
    reuse: boolean;
    /** Ex command creating the split (default `"botright vsplit"`); ignored for `float`. */
    splitCommand?: string;
    /** Float size as fractions of the editor (default `{width: 0.8, height: 0.8}`); ignored for `split`. */
    floatSize?: { width: number; height: number };
    /** Window title (float border title / statusline); default `name`. */
    title?: string;
    /** Highlighter for `layout.codeRegions`; absent = no syntax colours. */
    highlighter?: CodeHighlighter;
    /** Content provider; see {@link RefreshHook}. */
    refresh: RefreshHook;
    /** Key map overrides. */
    keymaps?: KeyMap;
    /** Called for a `url` link instead of the default opener (`coc.nvim` `workspace.openResource`/`vim.ui.open`). */
    onOpenUrl?: (target: Extract<LinkTarget, { kind: "url" }>) => void | Promise<void>;
}

/** A live view. Methods resolve once nvim applied the change; all are no-ops after `close`. */
export interface View {
    /** The buffer number. */
    readonly bufnr: number;
    /** The window id, or -1 when the buffer is not displayed. */
    readonly winid: number;
    /** Re-runs the refresh hook with `reason` (default `context`) and shows the result, keeping the cursor line when possible. */
    refresh(reason?: RefreshRequest["reason"]): Promise<void>;
    /** Shows `result` directly (bypassing the hook), keeping the cursor line when possible. */
    update(result: RefreshResult): Promise<void>;
    /** Closes the window (and wipes the buffer unless reused). Idempotent. */
    close(): Promise<void>;
    /** Resolves when the view is closed (by `close`, `q`, or the user wiping the buffer). */
    readonly closed: Promise<void>;
}

/** Reads `&background` into a ThemeKind (`light` or `dark`; no high-contrast hint exists in the editor). */
export async function detectThemeKind(nvim: Neovim): Promise<ThemeKind> {
    return themeKindOf((await nvim.eval("&background")) as string);
}

/**
 * Opens (or reuses) the window and buffer, then fills it through `opts.refresh({reason: "open", …})`, defines the
 * groups, places marks, runs the highlighter (treesitter first, hljs for the rest) and installs keymaps and
 * autocommands (resize, ColorScheme, BufWipeout). `nvim` is passed in (not imported) so the view is testable.
 * On Vim (`has('nvim') == 0`) the view is always a split with text properties (see the module doc).
 */
export async function open(nvim: Neovim, opts: ViewOptions): Promise<View> {
    const isNvim = ((await nvim.call("has", ["nvim"])) as number) === 1;
    const backend = isNvim ? await createNvimBackend(nvim) : createVimBackend(nvim);
    const token = newToken();
    const spec = openSpec(opts, token);
    const opened = await backend.open(isNvim ? spec : { ...spec, mode: "split" });
    const view = createView(nvim, backend, opts, token, opened);
    await view.refresh("open");
    return view;
}
