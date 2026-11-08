/**
 * The View object: owns the view's only state (buffer, window, shown layout, context selection), serialises
 * refreshes, and dispatches editor events (resize, ColorScheme, window changes, keys, close).
 */
import type { Neovim } from "coc.nvim";
import type { Layout, LinkTarget } from "../types";
import type { RefreshRequest, RefreshResult, View, ViewOptions } from "./index";
import type { Backend, OpenSpec, ViewEvent, WinState } from "./backend";
import { subscribe } from "./backend";
import { flattenVirtual, noDecorations, toDecorations, toExtmarks, toHlSpec } from "./convert";
import { buildRequest, mergeKeymap, resolveKey } from "./keys";

/** ViewOptions with defaults applied, as the backends take them. */
export function openSpec(opts: ViewOptions, token: string): OpenSpec {
    return {
        name: opts.name,
        reuse: opts.reuse,
        mode: opts.mode,
        splitCommand: opts.splitCommand ?? "botright vsplit",
        floatWidth: opts.floatSize?.width ?? 0.8,
        floatHeight: opts.floatSize?.height ?? 0.8,
        title: opts.title ?? opts.name,
        token,
        keys: mergeKeymap(opts.keymaps),
    };
}

interface State {
    bufnr: number;
    winid: number;
    width: number;
    background: string;
    layout: Layout;
    selected: Record<string, string>;
    closed: boolean;
    queue: Promise<void>;
}

/**
 * The latest refresh started on each buffer. Views reusing one buffer have separate queues, so an older View's
 * refresh still in flight must not write over (or mark up) the newer View's content.
 */
const generations = new Map<number, number>();

function nextGeneration(bufnr: number): number {
    const generation = (generations.get(bufnr) ?? 0) + 1;
    generations.set(bufnr, generation);
    return generation;
}

/**
 * Shows `result`: lines, groups and marks in one call, then treesitter, then hljs for the regions it left; every
 * step is skipped once a newer refresh of the buffer started.
 */
async function show(nvim: Neovim, backend: Backend, opts: ViewOptions, state: State, result: RefreshResult, generation: number): Promise<void> {
    const current = (): boolean => generations.get(state.bufnr) === generation;
    // Vim has no virtual text: the decorations become buffer text first, and the key handling sees the shifted links.
    const layout: Layout = backend.isNvim ? result.layout : flattenVirtual(result.layout);
    const decor = backend.isNvim ? toDecorations(layout) : noDecorations();
    const highlighter = opts.highlighter;
    if (current()) {
        state.layout = layout;
        state.selected = result.selected ?? state.selected;
        await backend.write(state.bufnr, layout.lines, result.groups.map(toHlSpec), toExtmarks(layout.lines, layout.marks), decor);
    }
    if (highlighter !== undefined && layout.codeRegions.length > 0 && current()) {
        const handled = backend.isNvim
            ? (await highlighter.treesitter(nvim, state.bufnr, backend.codeNs, layout.codeRegions)).handled
            : [];
        const rest = layout.codeRegions.filter((_, i) => handled.indexOf(i) === -1);
        const marks = rest.length > 0 && current() ? toExtmarks(layout.lines, highlighter.hljs(rest)) : [];
        await (marks.length > 0 ? backend.codeMarks(state.bufnr, marks) : Promise.resolve());
    }
}

/** Runs `task` after every queued one (refreshes never interleave); a failure does not block later tasks. */
function enqueue(state: State, task: () => Promise<void>): Promise<void> {
    const run = state.queue.then(() => (state.closed ? undefined : task()));
    state.queue = run.catch(() => undefined);
    return run;
}

function applyWin(state: State, win: Partial<WinState>): void {
    state.winid = win.winid ?? state.winid;
    state.width = win.width !== undefined && win.width > 0 ? win.width : state.width;
    state.background = win.background ?? state.background;
}

/**
 * Creates the View around an opened buffer and subscribes to its events; the first content comes from
 * `refresh("open")`, which the caller awaits.
 */
export function createView(nvim: Neovim, backend: Backend, opts: ViewOptions, token: string, opened: WinState & { bufnr: number }): View {
    const state: State = {
        bufnr: opened.bufnr,
        winid: opened.winid,
        width: opened.width,
        background: opened.background,
        layout: { lines: [], marks: [], links: [], anchors: [], codeRegions: [] },
        selected: {},
        closed: false,
        queue: Promise.resolve(),
    };
    let resolveClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
    });
    let unsubscribe: () => void = () => undefined;
    const finish = (): void => {
        state.closed = true;
        unsubscribe();
        resolveClosed();
    };
    const refresh = (reason: RefreshRequest["reason"] = "context", target?: LinkTarget): Promise<void> =>
        enqueue(state, async () => {
            const generation = nextGeneration(state.bufnr);
            const req = buildRequest(reason, state.width, state.background, state.selected, backend.isNvim, target);
            await show(nvim, backend, opts, state, await opts.refresh(req), generation);
        });
    const onKey = async (ev: ViewEvent): Promise<void> => {
        const effect = resolveKey(ev.action ?? "follow", state.layout, { line: ev.line ?? 0, col: ev.col ?? 0 }, state.selected);
        if (effect.kind === "close") {
            await view.close();
        } else if (effect.kind === "cursor") {
            await backend.cursor(state.bufnr, effect.line, effect.col);
        } else if (effect.kind === "url") {
            await (opts.onOpenUrl !== undefined ? opts.onOpenUrl(effect.target) : backend.openUrl(effect.target.href));
        } else if (effect.kind === "activate") {
            await refresh("context", effect.target);
        }
    };
    const onEvent = (ev: ViewEvent): void => {
        const before = state.width;
        applyWin(state, ev);
        if (ev.kind === "closed") {
            finish();
        } else if (ev.kind === "key") {
            void onKey(ev).catch(() => undefined);
        } else if (ev.kind === "colorscheme") {
            void refresh("colorscheme").catch(() => undefined);
        } else if ((ev.kind === "resize" || ev.kind === "win") && state.width !== before) {
            void refresh("resize").catch(() => undefined);
        }
    };
    unsubscribe = subscribe(nvim, token, onEvent);
    const view: View = {
        get bufnr(): number {
            return state.bufnr;
        },
        get winid(): number {
            return state.closed ? -1 : state.winid;
        },
        refresh,
        update: (result: RefreshResult) => enqueue(state, () => show(nvim, backend, opts, state, result, nextGeneration(state.bufnr))),
        close: async () => {
            const wasOpen = !state.closed;
            state.closed = true;
            await (wasOpen ? backend.close(state.bufnr).catch(() => undefined) : Promise.resolve());
            finish();
        },
        closed,
    };
    return view;
}
