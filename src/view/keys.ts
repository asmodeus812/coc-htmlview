/**
 * Pure key handling: the default key map, merging overrides, and resolving what an action does at a cursor
 * position (links, anchors, contexts). The view turns a {@link KeyEffect} into editor calls.
 */
import type { Layout, Link, LinkTarget } from "../types";
import type { ThemeKind } from "../types";
import type { KeyAction, KeyMap, RefreshRequest } from "./index";
import { byteToCell, cellToByte } from "../common";

/** The default key map (see `KeyAction`). */
const DEFAULT_KEYMAP: Readonly<Record<string, KeyAction>> = Object.freeze({
    q: "close",
    "<CR>": "follow",
    gx: "openUrl",
    "<Tab>": "nextLink",
    "<S-Tab>": "prevLink",
    "]]": "nextAnchor",
    "[[": "prevAnchor",
    "]c": "nextContext",
    "[c": "prevContext",
});

/** Merges overrides over the defaults (`false` removes a key) into `[lhs, action]` pairs, sorted by lhs. */
export function mergeKeymap(overrides: KeyMap | undefined): Array<[string, KeyAction]> {
    const merged: Record<string, KeyAction | false> = { ...DEFAULT_KEYMAP, ...(overrides ?? {}) };
    return Object.keys(merged)
        .sort()
        .filter((lhs) => merged[lhs] !== false)
        .map((lhs) => [lhs, merged[lhs] as KeyAction]);
}

/** A cursor in buffer terms: 0-based line, UTF-8 byte column. */
export interface Cursor {
    line: number;
    col: number;
}

/** What an action resolves to. */
export type KeyEffect =
    | { kind: "none" }
    | { kind: "close" }
    | { kind: "cursor"; line: number; col: number }
    | { kind: "url"; target: Extract<LinkTarget, { kind: "url" }> }
    | { kind: "activate"; target: Extract<LinkTarget, { kind: "context" }> };

function cellOf(layout: Layout, cursor: Cursor): number {
    return byteToCell(layout.lines[cursor.line] ?? "", cursor.col);
}

function sortedLinks(layout: Layout): Link[] {
    return layout.links.slice().sort((a, b) => a.line - b.line || a.startCol - b.startCol);
}

/** The link under the cursor, if any. */
export function linkAt(layout: Layout, cursor: Cursor): Link | undefined {
    const cell = cellOf(layout, cursor);
    return layout.links.find((l) => l.line === cursor.line && l.startCol <= cell && cell < l.endCol);
}

/** The next (`dir` 1) or previous (`dir` -1) link start relative to the cursor; no wrap-around. */
export function adjacentLink(layout: Layout, cursor: Cursor, dir: 1 | -1): Link | undefined {
    const cell = cellOf(layout, cursor);
    const links = sortedLinks(layout);
    const after = (l: Link): boolean => l.line > cursor.line || (l.line === cursor.line && l.startCol > cell);
    const before = (l: Link): boolean => l.line < cursor.line || (l.line === cursor.line && l.endCol <= cell);
    return dir === 1 ? links.find(after) : links.filter(before).pop();
}

/** The line of the next / previous anchor relative to the cursor line; no wrap-around. */
export function adjacentAnchor(layout: Layout, line: number, dir: 1 | -1): number | undefined {
    const lines = layout.anchors.map((a) => a.line).sort((a, b) => a - b);
    return dir === 1 ? lines.find((l) => l > line) : lines.filter((l) => l < line).pop();
}

/**
 * The context to select for `]c`/`[c`: the group is the one of the nearest `context` link at or above the cursor
 * (else the first one); its labels are all links of that group, ordered left to right; the current one is
 * `selected[contexts]` or the first label; the move cycles through them and wraps.
 */
export function adjacentContext(
    layout: Layout,
    line: number,
    selected: Record<string, string>,
    dir: 1 | -1
): { contexts: string; key: string } | undefined {
    const labels = sortedLinks(layout).filter((l) => l.target.kind === "context");
    const above = labels.filter((l) => l.line <= line).pop();
    const anchor = above ?? labels[0];
    let result: { contexts: string; key: string } | undefined;
    if (anchor !== undefined && anchor.target.kind === "context") {
        const contexts = anchor.target.contexts;
        // one group = one radio group, whatever line each title ended up on (a selected tab's box can push its title
        // down); titles read left to right
        const keys = labels
            .filter((l) => l.target.kind === "context" && l.target.contexts === contexts)
            .sort((x, y) => x.startCol - y.startCol || x.line - y.line)
            .map((l) => (l.target as Extract<LinkTarget, { kind: "context" }>).key);
        const current = Math.max(0, keys.indexOf(selected[contexts] ?? keys[0]));
        result = { contexts, key: keys[(current + dir + keys.length) % keys.length] };
    }
    return result;
}

function followTarget(layout: Layout, target: LinkTarget | undefined): KeyEffect {
    let effect: KeyEffect = { kind: "none" };
    if (target?.kind === "url") {
        effect = { kind: "url", target };
    } else if (target?.kind === "context") {
        effect = { kind: "activate", target };
    } else if (target?.kind === "anchor") {
        const id = target.id;
        const anchor = layout.anchors.find((a) => a.id === id);
        effect = anchor !== undefined ? { kind: "cursor", line: anchor.line, col: 0 } : effect;
    }
    return effect;
}

function linkCursor(layout: Layout, link: Link | undefined): KeyEffect {
    return link !== undefined
        ? { kind: "cursor", line: link.line, col: cellToByte(layout.lines[link.line] ?? "", link.startCol) }
        : { kind: "none" };
}

/** Resolves `action` at `cursor` against the shown layout and context selection. Pure. */
export function resolveKey(
    action: KeyAction,
    layout: Layout,
    cursor: Cursor,
    selected: Record<string, string>
): KeyEffect {
    let effect: KeyEffect = { kind: "none" };
    if (action === "close") {
        effect = { kind: "close" };
    } else if (action === "follow") {
        effect = followTarget(layout, linkAt(layout, cursor)?.target);
    } else if (action === "openUrl") {
        const target = linkAt(layout, cursor)?.target;
        effect = target?.kind === "url" ? { kind: "url", target } : effect;
    } else if (action === "nextLink" || action === "prevLink") {
        effect = linkCursor(layout, adjacentLink(layout, cursor, action === "nextLink" ? 1 : -1));
    } else if (action === "nextAnchor" || action === "prevAnchor") {
        const line = adjacentAnchor(layout, cursor.line, action === "nextAnchor" ? 1 : -1);
        effect = line !== undefined ? { kind: "cursor", line, col: 0 } : effect;
    } else {
        const next = adjacentContext(layout, cursor.line, selected, action === "nextContext" ? 1 : -1);
        effect = next !== undefined ? { kind: "activate", target: { kind: "context", contexts: next.contexts, key: next.key } } : effect;
    }
    return effect;
}

/** Maps `&background` to a theme kind. */
export function themeKindOf(background: string): ThemeKind {
    return background === "light" ? "light" : "dark";
}

/** Builds the refresh request (copies `selected`, so the hook cannot mutate the view's state). */
export function buildRequest(
    reason: RefreshRequest["reason"],
    width: number,
    background: string,
    selected: Record<string, string>,
    virtual: boolean,
    target?: LinkTarget
): RefreshRequest {
    return { reason, width: Math.max(1, width), selected: { ...selected }, themeKind: themeKindOf(background), virtual, target };
}
