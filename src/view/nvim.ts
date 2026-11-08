/**
 * Neovim backend: every operation is one call into the Lua module of `lua.ts`.
 */
import type { Neovim } from "coc.nvim";
import type { Backend, Opened, OpenSpec, WinState } from "./backend";
import type { Decorations, ExtmarkTuple, HlSpec } from "./convert";
import { callLua } from "./lua";

/** The Lua `M.open` argument for an OpenSpec (keys as `{lhs, action}` pairs). */
function luaOpenArgs(spec: OpenSpec): Record<string, unknown> {
    return {
        name: spec.name,
        reuse: spec.reuse,
        mode: spec.mode,
        splitCommand: spec.splitCommand,
        floatWidth: spec.floatWidth,
        floatHeight: spec.floatHeight,
        title: spec.title,
        border: spec.border,
        token: spec.token,
        keys: spec.keys,
    };
}

/** Creates the Neovim backend with its two namespaces (`htmlview`, `htmlview-code`). */
export async function createNvimBackend(nvim: Neovim): Promise<Backend> {
    const ns = await nvim.createNamespace("htmlview");
    const codeNs = await nvim.createNamespace("htmlview-code");
    return {
        isNvim: true,
        codeNs,
        open: (spec: OpenSpec) => callLua<Opened>(nvim, "open", [luaOpenArgs(spec)]),
        state: (bufnr: number) => callLua<WinState>(nvim, "state", [bufnr]),
        write: async (bufnr: number, lines: string[], specs: HlSpec[], marks: ExtmarkTuple[], decor: Decorations) => {
            await callLua(nvim, "update", [bufnr, ns, codeNs, lines, specs, marks, decor]);
        },
        codeMarks: async (bufnr: number, marks: ExtmarkTuple[]) => {
            await callLua(nvim, "marks", [bufnr, codeNs, marks]);
        },
        cursor: async (bufnr: number, line: number, col: number) => {
            await callLua(nvim, "cursor", [bufnr, line, col]);
        },
        openUrl: async (href: string) => {
            await callLua(nvim, "open_url", [href]);
        },
        close: async (bufnr: number) => {
            await callLua(nvim, "close", [bufnr]);
        },
    };
}
