/**
 * The caller's stylesheet files: read by path and parsed after the built-in base, with a small cache keyed by the
 * paths and their modification times (an edited file is re-read on the next render). Plain module state, bounded.
 */
import * as fs from "fs";
import * as engine from "./engine";

const LIMIT = 16;
const cache: Map<string, engine.css.Stylesheet[]> = new Map<string, engine.css.Stylesheet[]>();

/** A readable stylesheet file. */
interface SheetFile {
    path: string;
    mtime: number;
}

/** The file's identity, or `undefined` when it cannot be read. */
function statSheet(file: string): SheetFile | undefined {
    let found: SheetFile | undefined;
    try {
        found = { path: file, mtime: fs.statSync(file).mtimeMs };
    } catch {
        found = undefined;
    }
    return found;
}

/** The text of a stylesheet file, `undefined` when it cannot be read. */
function readSheet(file: string): string | undefined {
    let text: string | undefined;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch {
        text = undefined;
    }
    return text;
}

/**
 * The parsed sheets of `paths` (cascade order), the built-in base first. An unreadable path is skipped with one
 * line to `log`.
 */
export function loadSheets(paths: readonly string[], log: (message: string) => void): engine.css.Stylesheet[] {
    const files: SheetFile[] = [];
    paths.forEach((file: string): void => {
        const found: SheetFile | undefined = statSheet(file);
        if (found === undefined) {
            log(`htmlview: cannot read stylesheet '${file}', skipped`);
        } else {
            files.push(found);
        }
    });
    const key: string = JSON.stringify(files.map((f: SheetFile): [string, number] => [f.path, f.mtime]));
    const hit: engine.css.Stylesheet[] | undefined = cache.get(key);
    let sheets: engine.css.Stylesheet[];
    if (hit !== undefined) {
        sheets = hit;
    } else {
        const sources: engine.style.SheetSource[] = [];
        files.forEach((f: SheetFile): void => {
            const text: string | undefined = readSheet(f.path);
            if (text === undefined) {
                log(`htmlview: cannot read stylesheet '${f.path}', skipped`);
            } else {
                sources.push({ name: f.path, text, origin: "author" });
            }
        });
        sheets = engine.style.parseSheets(sources);
        if (cache.size >= LIMIT) {
            cache.delete(cache.keys().next().value as string);
        }
        cache.set(key, sheets);
    }
    return sheets;
}
