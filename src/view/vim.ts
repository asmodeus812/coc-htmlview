/**
 * Vim fallback backend (`has('nvim') == 0`): a split buffer with the text, marks as text properties through coc's
 * highlight helpers (`coc#highlight#set`), groups as `:hi` (variable links `:hi def link`), `BufWipeout` and the keymaps. No float, no
 * treesitter, no resize/ColorScheme tracking.
 */
import type { Neovim } from "coc.nvim";
import type { Backend, Opened, OpenSpec, WinState } from "./backend";
import { type ExtmarkTuple, type HlSpec, liveRefs, vimHiCommand } from "./convert";

/** A Vim single-quoted string literal. */
function vimStr(text: string): string {
    return `'${text.replace(/'/g, "''")}'`;
}

/** The notify call a Vim mapping/autocmd runs for event `kind` (extra entries are Vim expressions). */
export function vimNotify(token: string, kind: string, extra: Record<string, string> = {}): string {
    const fields = [`'token': ${vimStr(token)}`, `'kind': ${vimStr(kind)}`].concat(
        Object.keys(extra).map((k) => `'${k}': ${extra[k]}`)
    );
    return `call coc#rpc#notify('CocAutocmd', ['HtmlviewEvent', {${fields.join(", ")}}])`;
}

/** coc highlight items `[group, line, colStart, colEnd, combine]` for extmark tuples (lineHl = whole line). */
export function vimItems(marks: ExtmarkTuple[]): Array<[string, number, number, number, number]> {
    return marks.map((m) => [m[3], m[0], m[5] === 1 ? 0 : m[1], m[5] === 1 ? -1 : m[2], 1]);
}

/** The Ex commands installing the keymaps of `spec` on the current buffer. */
function vimKeyCommands(spec: OpenSpec): string[] {
    return spec.keys.map(([lhs, action]) => {
        const call = vimNotify(spec.token, "key", { action: vimStr(action), line: "line('.') - 1", col: "col('.') - 1" });
        return `nnoremap <buffer><nowait><silent> ${lhs} :${call}<CR>`;
    });
}

const STATE_EXPR = (bufnr: number): string =>
    `bufwinid(${bufnr}) == -1 ? [-1, -1, &background] : ` +
    `[bufwinid(${bufnr}), getwininfo(bufwinid(${bufnr}))[0].width - getwininfo(bufwinid(${bufnr}))[0].textoff, &background]`;

async function readState(nvim: Neovim, bufnr: number): Promise<WinState> {
    const [winid, width, background] = (await nvim.eval(STATE_EXPR(bufnr))) as [number, number, string];
    return { winid, width, background };
}

async function findBuffer(nvim: Neovim, name: string): Promise<number> {
    const expr = `get(filter(getbufinfo(), {_, b -> b.name ==# ${vimStr(name)} || b.name ==# fnamemodify(${vimStr(name)}, ':p')}), 0, {'bufnr': -1}).bufnr`;
    return (await nvim.eval(expr)) as number;
}

async function openVim(nvim: Neovim, spec: OpenSpec): Promise<Opened> {
    const existing = await findBuffer(nvim, spec.name);
    const reused = spec.reuse && existing > 0;
    const shown = reused ? ((await nvim.call("bufwinid", [existing])) as number) : -1;
    const name = existing > 0 && !reused ? `${spec.name} [${spec.token}]` : spec.name;
    const show = shown !== -1 ? `call win_gotoid(${shown})` : `${spec.splitCommand} | ${reused ? `buffer ${existing}` : "enew"}`;
    await nvim.command(show);
    const bufnr = (await nvim.call("bufnr", ["%"])) as number;
    const group = `htmlview_${bufnr}`;
    await nvim.command(
        [
            "setlocal buftype=nofile bufhidden=hide noswapfile nomodifiable nowrap conceallevel=0 filetype=htmlview",
            reused ? "" : `execute 'file ' . fnameescape(${vimStr(name)})`,
            `let b:htmlview_reuse = ${spec.reuse ? 1 : 0}`,
            `augroup ${group}`,
            "autocmd!",
            `autocmd BufWipeout <buffer=${bufnr}> ${vimNotify(spec.token, "closed")}`,
            "augroup END",
            ...vimKeyCommands(spec),
        ]
            .filter((c) => c !== "")
            .join("\n")
            .split("\n")
            .map((c) => `execute ${vimStr(c)}`)
            .join(" | ")
    );
    return { bufnr, ...(await readState(nvim, bufnr)) };
}

async function defineGroups(nvim: Neovim, specs: HlSpec[]): Promise<void> {
    const refs = liveRefs(specs);
    const exprs = refs.map((r) => `synIDattr(synIDtrans(hlID(${vimStr(r.group)})), '${r.attr}#')`);
    const values = (await nvim.eval(`[synIDattr(synIDtrans(hlID('Normal')), 'bg#'), ${exprs.join(", ")}]`)) as string[];
    const live: Record<string, string> = {};
    refs.forEach((r, i) => {
        live[`${r.group}.${r.attr}`] = values[i + 1];
    });
    const base = values[0] || "#000000";
    const cmds = specs.map((s) => `execute ${vimStr(vimHiCommand(s, live, base))}`);
    await (cmds.length > 0 ? nvim.command(cmds.join(" | ")) : Promise.resolve());
}

/** Creates the Vim fallback backend. */
export function createVimBackend(nvim: Neovim): Backend {
    return {
        isNvim: false,
        codeNs: -1,
        open: (spec: OpenSpec) => openVim(nvim, spec),
        state: (bufnr: number) => readState(nvim, bufnr),
        write: async (bufnr: number, lines: string[], specs: HlSpec[], marks: ExtmarkTuple[]) => {
            await nvim.call("setbufvar", [bufnr, "&modifiable", 1]);
            await nvim.call("deletebufline", [bufnr, 1, "$"]);
            await nvim.call("setbufline", [bufnr, 1, lines]);
            await nvim.call("setbufvar", [bufnr, "&modifiable", 0]);
            await defineGroups(nvim, specs);
            await nvim.call("coc#highlight#clear_highlight", [bufnr, "htmlview-code", 0, -1]);
            await nvim.call("coc#highlight#set", [bufnr, "htmlview", vimItems(marks), 200]);
        },
        codeMarks: async (bufnr: number, marks: ExtmarkTuple[]) => {
            await nvim.call("coc#highlight#set", [bufnr, "htmlview-code", vimItems(marks), 300]);
        },
        cursor: async (bufnr: number, line: number, col: number) => {
            await nvim.command(`call win_execute(bufwinid(${bufnr}), 'call cursor(${line + 1}, ${col + 1})')`);
        },
        openUrl: async (href: string) => {
            await nvim.call("coc#ui#open_url", [href]);
        },
        close: async (bufnr: number) => {
            const reuse = (await nvim.call("getbufvar", [bufnr, "htmlview_reuse", 0])) as number;
            const cmd = reuse === 1
                ? `silent! autocmd! htmlview_${bufnr} | for w in win_findbuf(${bufnr}) | call win_execute(w, 'close') | endfor`
                : `silent! bwipeout! ${bufnr}`;
            await nvim.command(cmd);
        },
    };
}
