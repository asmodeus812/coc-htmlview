/**
 * coc-htmlview: `activate` returns the {@link HtmlViewApi} other extensions use (see `api.ts`). Everything else is
 * internal; see `render.ts` for the pipeline.
 */
import type { ExtensionContext } from "coc.nvim";
import type { HtmlViewApi, RenderOptions, View } from "./api";
import { renderOn } from "./render";
import { readSettings } from "./settings";

/** Renders `html` with the caller's options, defaulting mode and split command and appending the user's stylesheets. */
async function render(html: string, options: RenderOptions): Promise<View> {
    const coc: typeof import("coc.nvim") = require("coc.nvim");
    const s = readSettings(coc);
    return renderOn(coc.workspace.nvim, html, {
        ...options,
        stylesheets: [...(options.stylesheets ?? []), ...s.stylesheets],
        view: { ...options.view, mode: options.view.mode ?? s.mode, splitCommand: options.view.splitCommand ?? s.splitCommand }
    });
}

export function activate(_context: ExtensionContext): HtmlViewApi {
    return { version: 1, render };
}
