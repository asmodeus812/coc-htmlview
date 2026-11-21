/**
 * coc-htmlview: `activate` returns the {@link HtmlViewApi} other extensions use (see `api.ts`). Everything else is
 * internal; see `render.ts` for the pipeline.
 */
import type { ExtensionContext } from "coc.nvim";
import type { HtmlViewApi, RenderOptions, View } from "./api";
import { renderOn } from "./render";
import { applySettings, readSettings } from "./settings";

let configHome: Promise<string> | undefined;

/** coc's user config folder (where the user's coc-settings.json lives), read once; `""` when it cannot be read. */
function userConfigFolder(coc: typeof import("coc.nvim")): Promise<string> {
    if (configHome === undefined) {
        configHome = (coc.workspace.nvim.call("coc#util#get_config_home", []) as Promise<unknown>).then(
            (value: unknown): string => (typeof value === "string" ? value : ""),
            (): string => ""
        );
    }
    return configHome;
}

/** `render` for an extension installed at `extensionPath`: the caller's options under the user's settings ({@link applySettings}). */
function renderer(extensionPath: string): (html: string, options: RenderOptions) => Promise<View> {
    return async (html: string, options: RenderOptions): Promise<View> => {
        const coc: typeof import("coc.nvim") = require("coc.nvim");
        const expand = (f: string): string => coc.workspace.expand(f);
        const settings = readSettings(coc, await userConfigFolder(coc));
        return renderOn(coc.workspace.nvim, html, applySettings(options, settings, extensionPath, expand));
    };
}

export function activate(context: ExtensionContext): HtmlViewApi {
    return { version: 1, render: renderer(context.extensionPath) };
}
