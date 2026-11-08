/** HTML tokenizer: markup text to open/close/text tokens with decoded attribute values and text. */
import { HTMLElement, TextNode } from "node-html-parser";

/** A token of the markup. */
export type Token =
    | { kind: "open"; tag: string; attrs: Record<string, string> }
    | { kind: "close"; tag: string }
    | { kind: "text"; text: string };

/** Decodes character references once, with the entity table of the existing `node-html-parser` dependency. */
function decode(raw: string): string {
    return raw.indexOf("&") < 0 ? raw : new TextNode(raw, null as unknown as HTMLElement).text;
}

const ATTR: RegExp = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/y;
const TAG_NAME: RegExp = /[a-zA-Z][^\s/>]*/y;
const RAW_TEXT: ReadonlySet<string> = new Set(["script", "style"]);
const RCDATA: ReadonlySet<string> = new Set(["textarea", "title"]);

/** Reads attributes from `src` starting at `i`; returns them and the index after the tag's `>`. */
function readTag(src: string, start: number): { attrs: Record<string, string>; end: number } {
    const attrs: Record<string, string> = {};
    let i: number = start;
    let done: boolean = false;
    while (!done && i < src.length) {
        const c: string = src[i];
        if (c === ">") {
            i++;
            done = true;
        } else if (c === "/" || /\s/.test(c)) {
            i++;
        } else {
            ATTR.lastIndex = i;
            const m: RegExpExecArray | null = ATTR.exec(src);
            if (m === null) {
                i++;
            } else {
                const key: string = m[1].toLowerCase();
                if (key !== "__proto__" && !Object.prototype.hasOwnProperty.call(attrs, key)) {
                    attrs[key] = decode(m[2] ?? m[3] ?? m[4] ?? "");
                }
                i = ATTR.lastIndex;
            }
        }
    }
    return { attrs, end: i };
}

/** Index just after the first occurrence of `marker` at or after `from` (end of input when absent). */
function skipPast(src: string, marker: string, from: number): number {
    const at: number = src.indexOf(marker, from);
    return at < 0 ? src.length : at + marker.length;
}

/** Hand-written HTML tokenizer: linear, never throws; comments, doctype, CDATA and `<?…>` are skipped. */
export function tokenize(src: string): Token[] {
    const out: Token[] = [];
    let i: number = 0;
    let text: string = "";
    const flush = (): void => {
        if (text !== "") {
            out.push({ kind: "text", text: decode(text) });
            text = "";
        }
    };
    while (i < src.length) {
        const lt: number = src.indexOf("<", i);
        const next: string = lt >= 0 ? src[lt + 1] ?? "" : "";
        if (lt < 0) {
            text += src.slice(i);
            i = src.length;
        } else if (next === "!" || next === "?") {
            text += src.slice(i, lt);
            i = src.startsWith("<!--", lt) ? skipPast(src, "-->", lt + 4) : skipPast(src, ">", lt);
        } else if (next === "/" && /[a-zA-Z]/.test(src[lt + 2] ?? "")) {
            text += src.slice(i, lt);
            flush();
            TAG_NAME.lastIndex = lt + 2;
            const m: RegExpExecArray = TAG_NAME.exec(src) as RegExpExecArray;
            out.push({ kind: "close", tag: m[0].toLowerCase() });
            i = skipPast(src, ">", TAG_NAME.lastIndex);
        } else if (/[a-zA-Z]/.test(next)) {
            text += src.slice(i, lt);
            flush();
            TAG_NAME.lastIndex = lt + 1;
            const m: RegExpExecArray = TAG_NAME.exec(src) as RegExpExecArray;
            const tag: string = m[0].toLowerCase();
            const read: { attrs: Record<string, string>; end: number } = readTag(src, TAG_NAME.lastIndex);
            out.push({ kind: "open", tag, attrs: read.attrs });
            i = read.end;
            if (RAW_TEXT.has(tag) || RCDATA.has(tag)) {
                const finder: RegExp = new RegExp("</" + tag + "(?=[\\s/>])", "gi");
                finder.lastIndex = i;
                const close: RegExpExecArray | null = finder.exec(src);
                const stop: number = close === null ? src.length : close.index;
                const body: string = src.slice(i, stop);
                out.push({ kind: "text", text: RCDATA.has(tag) ? decode(body) : body });
                out.push({ kind: "close", tag });
                i = close === null ? src.length : skipPast(src, ">", stop);
            }
        } else {
            text += src.slice(i, lt + 1);
            i = lt + 1;
        }
    }
    flush();
    return out;
}
