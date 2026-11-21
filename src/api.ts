/**
 * The public contract of coc-htmlview: what `activate()` returns. Self-contained (no imports), so it is emitted
 * as `lib/api.d.ts` and can be copied into a consuming extension. `version` changes only on a breaking change.
 */

/** An HTML to HTML pass run before the document is parsed. Pure; returns the input on failure. */
export type HtmlPrepass = (html: string) => string;

/** Engine language ids for one language name. Absent = that engine is not tried. */
export interface LanguageEntry {
    /** Treesitter language (`vim.treesitter.language` name), e.g. `"java"`, `"tsx"`. */
    treesitter?: string;
    /** highlight.js language name, e.g. `"java"`, `"xml"`. */
    hljs?: string;
}

/** Render-time additions to the language table: a string aliases another name (`""` = no highlighting), an object gives the engine ids. */
export type LanguageOptions = Record<string, LanguageEntry | string>;

/** Why a view is refreshed. */
export type RefreshReason = "open" | "resize" | "context" | "colorscheme";

/** Window and buffer of a view. */
export interface ViewSpec {
    /** Buffer name and reuse key. */
    name: string;
    /** `split` or a centred `float` (Neovim only); default `htmlview.view.mode`. */
    mode?: "split" | "float";
    /** Ex command that creates the split; default `htmlview.view.splitCommand`. */
    splitCommand?: string;
    /** Reuse the window and buffer of an earlier view with the same name; default false. */
    reuse?: boolean;
    /** Title of a float. */
    title?: string;
}

/** Options of {@link HtmlViewApi.render}. */
export interface RenderOptions {
    /**
     * Stylesheet file paths in cascade order, applied after the user's `htmlview.stylesheets` so they win. `~` and
     * environment variables are expanded; relative paths resolve against {@link root}. Unreadable paths are skipped.
     */
    stylesheets?: string[];
    /** The folder relative `stylesheets` resolve against, usually the caller's `context.extensionPath`; default coc-htmlview's own folder. */
    root?: string;
    /** An HTML to HTML pass run before parsing. */
    prepass?: HtmlPrepass;
    /** Language name for code blocks that name none. */
    lang?: string;
    /** Extends or overrides the default language table. */
    languages?: LanguageOptions;
    /** Where and under which name the view opens. */
    view: ViewSpec;
}

/** A live view. */
export interface View {
    /** The buffer number. */
    readonly bufnr: number;
    /** The window id, or -1 when the buffer is not displayed. */
    readonly winid: number;
    /** Re-renders (default reason `context`), keeping the cursor line when possible. */
    refresh(reason?: RefreshReason): Promise<void>;
    /** Closes the window. Idempotent. */
    close(): Promise<void>;
    /** Resolves when the view is closed. */
    readonly closed: Promise<void>;
}

/** What `activate()` of coc-htmlview returns (`extensions.getExtensionById("coc-htmlview").exports`). */
export interface HtmlViewApi {
    readonly version: 1;
    /** Renders `html` into a view on the editor's Neovim or Vim. */
    render(html: string, options: RenderOptions): Promise<View>;
}
