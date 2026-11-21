/**
 * coc-htmlview: `activate` returns the {@link HtmlViewApi} other extensions use (see `api.ts`). Everything else is
 * internal; see `render.ts` for the pipeline.
 */
import type { ExtensionContext } from "coc.nvim";
import type { HtmlViewApi, RenderOptions, View } from "./api";
import { renderOn } from "./render";
import { applySettings, readSettings } from "./settings";

/** Renders `html` with the caller's options under the user's settings ({@link applySettings}). */
async function render(html: string, options: RenderOptions): Promise<View> {
    const coc: typeof import("coc.nvim") = require("coc.nvim");
    return renderOn(coc.workspace.nvim, html, applySettings(options, readSettings(coc)));
}

export function activate(_context: ExtensionContext): HtmlViewApi {
    return { version: 1, render };
}
