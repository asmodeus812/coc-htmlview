/**
 * The TS side of the Neovim view module: the Lua source (view.lua, bundled as text) owns every editor operation,
 * so each view action costs one `nvim_exec_lua` round trip. It is loaded once per source version into
 * `package.loaded` and called through {@link callLua}. Events go back to node as `CocAutocmd` notifications named
 * `HtmlviewEvent` (coc fires them as a no-op event; the view's own `notification` listener picks them up).
 */
import type { Neovim } from "coc.nvim";
import VIEW_LUA from "./view.lua";

/** djb2 of the source, so an edited module is reloaded instead of served from `package.loaded`. */
function sourceKey(src: string): string {
    let h = 5381;
    for (let i = 0; i < src.length; i++) {
        h = ((h << 5) + h + src.charCodeAt(i)) >>> 0;
    }
    return `coc_htmlview_view_${h.toString(16)}`;
}

/** The loader chunk: caches the module per source key, then calls `M[fn](unpack(args))`. */
const LUA_LOADER = [
    "local key, src, fn, args = ...",
    "local M = package.loaded[key]",
    "if M == nil then M = assert(loadstring(src, key))() package.loaded[key] = M end",
    "return M[fn](unpack(args))",
].join("\n");

/** The module key (constant per source version). */
const LUA_KEY: string = sourceKey(VIEW_LUA);

/** Calls `M[fn](...args)` of {@link VIEW_LUA} in one `nvim_exec_lua` round trip. */
export async function callLua<T>(nvim: Neovim, fn: string, args: unknown[]): Promise<T> {
    const result = await nvim.lua(LUA_LOADER, [LUA_KEY, VIEW_LUA, fn, args as never]);
    return result as unknown as T;
}
