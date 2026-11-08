/**
 * The pure highlight.js pass: tokenizes each region with its hljs language and turns the `hljs-*` scopes of the
 * HTML that `hljs.highlight` returns (its public output) into cell-based marks. Each region is isolated: an error
 * in one yields no marks for that region only.
 */
import hljs from "highlight.js";
import { MarkPriority, displayWidth } from "../common";
import type { CodeRegion, Mark } from "../types";
import type { LanguageTable } from "./index";
import { resolveLanguage } from "./languages";

/** One scope of the hljs output: its classes and where its text starts and ends in the decoded region text. */
interface Scope {
    classes: string[];
    start: number;
    end: number;
    depth: number;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'", "#39": "'" };

/** Decodes the few entities `hljs` escapes; anything else stays as written. */
function decodeEntities(text: string): string {
    return text.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (_m: string, name: string) => ENTITIES[name]);
}

/**
 * Scans the hljs HTML (only `<span class="…">`, `</span>` and escaped text occur) into decoded text plus the
 * closed scopes with their offsets into it and their nesting depth (1 = outermost).
 */
export function scanHljsHtml(html: string): { text: string; scopes: Scope[] } {
    const scopes: Scope[] = [];
    const open: Scope[] = [];
    let text = "";
    const re = /<span class="([^"]*)">|<\/span>|([^<]+)/g;
    let m: RegExpExecArray | null = re.exec(html);
    while (m !== null) {
        if (m[1] !== undefined) {
            open.push({ classes: m[1].split(/\s+/).filter((c: string) => c !== ""), start: text.length, end: -1, depth: open.length + 1 });
        } else if (m[2] !== undefined) {
            text += decodeEntities(m[2]);
        } else {
            const scope = open.pop();
            if (scope !== undefined) {
                scope.end = text.length;
                scopes.push(scope);
            }
        }
        m = re.exec(html);
    }
    return { text, scopes };
}

/** First group `groupForClass` gives for the scope's classes, in their written order (`hljs-title` before `class_`). */
function groupOf(classes: string[], groupForClass: (cls: string) => string | undefined): string | undefined {
    let group: string | undefined;
    for (const cls of classes) {
        if (group === undefined) {
            group = groupForClass(cls);
        }
    }
    return group;
}

/** Splits a scope `[start, end)` of `text` into one mark per region line it covers (empty pieces dropped). */
function scopeMarks(region: CodeRegion, text: string, scope: Scope, group: string): Mark[] {
    const marks: Mark[] = [];
    const before = text.slice(0, scope.start).split("\n");
    const pieces = text.slice(scope.start, scope.end).split("\n");
    let line = region.startLine + before.length - 1;
    let col = region.startCol + displayWidth(before[before.length - 1]);
    const priority = MarkPriority.code + Math.min(scope.depth, 99);
    pieces.forEach((piece: string, i: number) => {
        if (i > 0) {
            line += 1;
            col = region.startCol;
        }
        const width = displayWidth(piece);
        if (width > 0) {
            marks.push({ line, startCol: col, endCol: col + width, group, priority });
        }
    });
    return marks;
}

/** Marks of one region; throws on hljs errors (the caller isolates regions). */
function regionMarks(
    region: CodeRegion,
    languages: LanguageTable,
    groupForClass: (cls: string) => string | undefined
): Mark[] {
    const lang = resolveLanguage(region.lang, languages).hljs;
    let marks: Mark[] = [];
    if (lang !== undefined && hljs.getLanguage(lang) !== undefined) {
        const html = hljs.highlight(region.text, { language: lang, ignoreIllegals: true }).value;
        const { text, scopes } = scanHljsHtml(html);
        for (const scope of scopes) {
            const group = groupOf(scope.classes, groupForClass);
            if (group !== undefined) {
                marks = marks.concat(scopeMarks(region, text, scope, group));
            }
        }
    }
    return marks;
}

/** See `highlightRegions` in `./index`. */
export function hljsRegions(
    regions: CodeRegion[],
    languages: LanguageTable,
    groupForClass: (cls: string) => string | undefined
): Mark[] {
    let marks: Mark[] = [];
    for (const region of regions) {
        try {
            marks = marks.concat(regionMarks(region, languages, groupForClass));
        } catch {
            // this region stays plain; the others are unaffected
        }
    }
    return marks;
}
