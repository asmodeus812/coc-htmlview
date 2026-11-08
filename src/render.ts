/**
 * The pipeline behind {@link render}, on an injectable Neovim client: html → (pre-pass) → engine dom → (sheets +
 * theme + form state → styled tree) → layout → view. This file only composes the parts; it owns no logic beyond keeping
 * the document for relayouts. Nothing here (or anywhere in htmlview) knows host-extension types.
 */
import type { Neovim } from "coc.nvim";
import type { Layout, ThemeKind } from "./types";
import type { LanguageOptions, CodeHighlighter, LanguageTable } from "./highlight";
import type { RefreshRequest, RefreshResult, View } from "./view";
import * as engine from "./engine";
import { buildLanguageTable, createHighlighter, defaultLanguageTable } from "./highlight";
import { loadSheets } from "./sheets";
import { open } from "./view";

const DEFAULT_TABSTOP = 4;

/** Options of {@link render}. */
export interface RenderOptions {
    /** Stylesheet FILE PATHS in cascade order, applied on top of htmlview's built-in base. Unreadable paths are skipped. */
    stylesheets?: string[];
    /** An HTML → HTML pass run before the document is parsed (the adapter's markup fix-ups). */
    prepass?: engine.HtmlPrepass;
    /** Language name for code blocks that name none. */
    lang?: string;
    /**
     * Extends or overrides the default language table (merged per render): a string value is an alias to another
     * name (`""` = no highlighting), an object gives the engine ids (`{treesitter, hljs}`) directly.
     */
    languages?: LanguageOptions;
    /** Window and buffer: where and under which name the view opens. */
    view: { mode: "split" | "float"; name: string; reuse?: boolean; splitCommand?: string; title?: string };
}

/** What {@link renderOn} takes besides the options (tests inject both). */
export interface RenderEnv {
    /** Receives one line per skipped stylesheet; default `console.error`. */
    log?: (message: string) => void;
}

/** A one-line layout for a document that cannot be rendered (requirement 7: no broken window). */
function failureLayout(e: unknown): Layout {
    const message: string = e instanceof Error ? e.message : String(e);
    return { lines: [`htmlview: cannot render: ${message.split("\n")[0]}`], marks: [], links: [], anchors: [], codeRegions: [] };
}

/** The parsed document (after the optional pre-pass) with its parsed sheets. */
interface ParsedInput {
    doc: engine.dom.DomDocument;
    sheets: engine.css.Stylesheet[];
}

/** Parses `html` and loads the option sheets once; throws on a parse failure. */
function parseInput(html: string, options: RenderOptions, log: (message: string) => void): ParsedInput {
    const doc: engine.dom.DomDocument = engine.dom.parseDocument(options.prepass !== undefined ? options.prepass(html) : html);
    return { doc, sheets: loadSheets(options.stylesheets ?? [], log) };
}

/** Neovim's 'tabstop' (the default `tab-size` of code), {@link DEFAULT_TABSTOP} when it cannot be read. */
async function readTabstop(nvim: Neovim): Promise<number> {
    let tabstop: number;
    try {
        const value: unknown = await nvim.eval("&tabstop");
        tabstop = typeof value === "number" && value > 0 ? value : DEFAULT_TABSTOP;
    } catch {
        tabstop = DEFAULT_TABSTOP;
    }
    return tabstop;
}

/**
 * Parses `html` once, then opens a view on `nvim` whose refresh hook re-runs only what changed on the kept document:
 * open/colorscheme/context restyle (cached sheets, form state) and lay out; resize only lays out.
 */
export async function renderOn(nvim: Neovim, html: string, options: RenderOptions, env: RenderEnv = {}): Promise<View> {
    const languages: LanguageTable = buildLanguageTable(defaultLanguageTable, options.languages);
    const tabstop: number = await readTabstop(nvim);
    let parsed: ParsedInput | undefined;
    let failure: unknown;
    try {
        parsed = parseInput(html, options, env.log ?? ((message: string): void => console.error(message)));
    } catch (e) {
        failure = e;
    }
    let form: engine.interact.FormState = parsed === undefined ? engine.interact.emptyFormState() : engine.interact.initialFormState(parsed.doc);
    let styled: engine.style.StyledTree | undefined;
    let styledKind: ThemeKind | undefined;
    let defined: Set<string> = new Set<string>();
    const restyleNow = (kind: ThemeKind): void => {
        if (parsed !== undefined) {
            styled = engine.style.computeStyles(parsed.doc, parsed.sheets, { themeKind: kind, vars: engine.defaultHostVars }, form);
            styledKind = kind;
            defined = new Set<string>(styled.groups.map((g): string => g.name));
        }
    };
    const highlighter: CodeHighlighter = createHighlighter(languages, (cls: string): string | undefined => {
        const name: string = engine.style.groupName("." + cls);
        return defined.has(name) ? name : undefined;
    });
    const refresh = (req: RefreshRequest): RefreshResult => {
        let result: RefreshResult;
        try {
            if (parsed === undefined) {
                throw failure;
            }
            if (req.reason === "context" && req.target !== undefined) {
                const act: engine.interact.Activation = engine.interact.activate(parsed.doc, form, req.target);
                if (act.kind === "restyle") {
                    form = act.state;
                    restyleNow(req.themeKind);
                }
            }
            if (styled === undefined || req.themeKind !== styledKind || req.reason === "open" || req.reason === "colorscheme") {
                restyleNow(req.themeKind);
            }
            const current: engine.style.StyledTree = styled as engine.style.StyledTree;
            const laid: Layout = engine.layout.layoutBoxes(current, {
                width: req.width,
                tabstop,
                defaultLang: options.lang,
                virtual: req.virtual
            });
            result = { layout: laid, groups: current.groups, selected: engine.interact.toSelection(form) };
        } catch (e) {
            result = { layout: failureLayout(e), groups: [] };
        }
        return result;
    };
    return open(nvim, { ...options.view, reuse: options.view.reuse ?? false, refresh, highlighter });
}
