# htmlview contract

htmlview renders HTML + CSS as browser-like text in a Neovim (or Vim) buffer. The Firefox oracle is the primary
acceptance check; the parity report is secondary.

## Parts and data flow

```
html ──(optional caller pre-pass)──▶ dom.parseDocument ──▶ DomDocument (preorder ids, parent table, <style> texts)
stylesheet paths ──sheets.loadSheets (path+mtime cache) → style.parseSheets (UA sheet first, origin ua; then author)──▶ Stylesheet[]
DomDocument ──interact.initialFormState──▶ FormState (radio/checkbox :checked)
(doc, sheets, StyleEnv{themeKind, vars}, state)
   ──style.computeStyles (css.matchRules, cascade, inheritance, var(), body class vscode-<kind>)──▶ StyledTree {root, groups}
StyledTree ──layout.layoutBoxes (buildBoxes → placeBoxes → emit)──▶ Layout (virtText, virtLines, conceals filled)
Layout.codeRegions ──highlight/ (treesitter first, hljs for the rest)──▶ token marks
Layout ──view/open──▶ buffer + window
key on a Link ──interact.activate──▶ restyle(state) | open(href) | jump(id)
```

| Part | Folder | Role |
|---|---|---|
| dom | `engine/dom/` | `parseDocument`: implied html/head/body, auto-closing, void and raw-text elements, entities decoded once |
| css | `engine/css/` | `parseSheet`, `parseInlineStyle`, `parseSelectorList`, `matches`, `matchRules` (sorted by `compareCascade`; `:checked` through `MatchContext.checked`) |
| style | `engine/style/` (`ua.css`, `host.ts`) | `parseSheets`, `computeStyles`: typed values, shorthands, var() with fallbacks, colours incl. alpha, pseudo-elements with `content`/counters/quotes, list markers, layout hints, paint groups and `GroupDef`s (rule groups and the groups of the sheets' `.hljs-*` rules) |
| layout | `engine/layout/` | `layoutBoxes`: boxes, placement (blocks, inline flow, tables, flex rows, inline-blocks), code regions, links, anchors, folds, virtual text |
| interact | `engine/interact/` | form state for radios/checkboxes: `findControls`, `initialFormState`, `toggle`, `isChecked`, `fromSelection`, `activate` |
| highlight | `highlight/` | `highlightRegions` (hljs), `treesitterRegions`, the language table |
| view | `view/` | the only nvim-facing part: buffer, window, groups, extmarks, keymaps, refresh events |
| common | `common/` | the display-cell convention (`displayWidth`, `cellToByte`, `byteToCell`) and `MarkPriority` |

`index.ts` is the public API: `render(html, options)` on coc's `workspace.nvim`; `render.ts` holds the pipeline
(`renderOn(nvim, html, options, env?)`, the same with an injectable client and logger, used by tests). It parses once,
keeps the document and the form state, and opens a view whose `refresh` hook restyles (on the parsed sheets) and lays out
for the width, context selection and theme the view reports. Open, colorscheme and context selection restyle; resize only
lays out. The view owns the only nvim state; every other part is pure data in, data out.

## Public API

`src/index.ts` exports only `activate`, which returns the `HtmlViewApi` declared in `src/api.ts` (emitted as
`lib/api.d.ts`; self-contained, `version: 1`). Tests import the parts directly.

```ts
api.render(html: string, options: {
    stylesheets?: string[];      // file paths, cascade order, on top of ua.css (first); htmlview.stylesheets come after
    prepass?: (html: string) => string;
    lang?: string;               // language of code blocks that name none
    languages?: LanguageOptions; // extends/overrides the generic language table
    view: { name: string; mode?: "split" | "float"; reuse?: boolean; splitCommand?: string; title?: string };
}): Promise<View>   // mode and splitCommand default to htmlview.view.mode / htmlview.view.splitCommand
```

- Document `<style>` blocks and `style=""` attributes are part of the HTML and always applied. All `stylesheets` cascade
  at author origin; their order sets precedence. `sheets.ts` caches the parsed sheets by path + mtime (an edited file is
  re-read on the next render); an unreadable path is skipped with one `console.error` line.
- Theme: detected from 'background', refreshed on ColorScheme / background changes. Initial tab and context: the
  HTML's `checked` attributes. Link targets: hidden unless `htmlview.linkTargets`, then ` 🔗 <href>` virtual text. List markers and prefixes: CSS only.
- `tab-size` (CSS, inherited) sets the tab width of code; unset, it is Neovim's 'tabstop' read at render (default 4).
- Removed options: `nvim`, `sheets`, `userSheets`, `sheetCache`, `vars`, `themeKind`, `selected`, `tabstop`,
  `linkTarget`, `icons`.

## Imports

Inside `src/`: `coc.nvim` (types only, and only in `view/`, `highlight/`, `index.ts`, `render.ts`), node built-ins, the
existing dependencies (`node-html-parser`, `css`, `highlight.js`), `import type` across parts, runtime imports
from `common/`. Never anything from the host extension (`src/` outside `htmlview`). Runtime imports across engine
parts are limited to: style → css `parseSheet`/`matchRules`/`compareCascade` and interact `isChecked`; layout → style
data constants (`hostRoles`, `defaultHostVars`, `LayoutHint`) and the naming and counter rules (`groupName`,
`markerText`).

## Coordinates

- **Lines**: 0-based buffer line indexes everywhere (Layout, Mark, Link, Anchor, CodeRegion, Fold); `endLine` of a
  line range is inclusive.
- **Columns**: 0-based display cells, `endCol` exclusive, in every part that is not nvim. One cell per normal
  character, 2 for wide (CJK, emoji), 0 for combining marks; `common.displayWidth` / `codePointWidth` are the only
  definition. Tabs never appear in `Layout.lines` (layout expands them with `tabstop`).
- **Bytes**: only the view (and the Lua side of treesitter) uses UTF-8 byte columns, converting with
  `common.cellToByte` / `byteToCell` where it places or reads an extmark.
- **Priorities**: `common.MarkPriority` bands: `line` (lineHl diff backgrounds) < `style` + element depth < `code` +
  token scope depth < `ui`. A paint group's priority is `layout.paintPriority(MarkPriority.style, depth, layer)`:
  inner elements and later rules win.
- **Lengths**: CSS lengths become cells/lines in style only (`style.lengthToCells`: ch 1, em 1 cell / 1 line, px /8
  horizontal and /16 vertical, % horizontal only); layout never sees units. `VirtText.col` is a cell of the buffer
  line; inline virtual text takes screen cells, so layout counts its width when wrapping.

## Layout rules

- Layout never checks a tag name or class: it reads `ComputedStyle.display` and the `LayoutHint` custom properties
  (`--htmlview-code|heading|link|replaced|toggle|break`, not inherited), which come from `ua.css` or author sheets.
- A box built from an element carries its attributes (`BoxBase.attrs`) plus two derived ones: `data-htmlview-lang`
  (code language of a code block) and `data-htmlview-toggle` (radio group name, or `checkbox`, of a toggle label; its
  key is `for`). Emit and place read href, id, language and toggle from `attrs`.
- Flex (`display: flex`, row only): the container is a block; each item takes its shrink-to-fit width (max-content
  capped at the content width), items sit side by side 1 cell apart (0 when their margins separate them) and wrap
  greedily onto a new row when the next does not fit. Items go in `order` (ties: document order); an item with
  `width: 100%` (`ComputedStyle.fill`) takes a row of its own. Item margins do not collapse. Atomic inlines
  (inline-block) shrink to fit the same way.
- With `opts.virtual === false` (Vim) decorations are buffer text; link targets stay virtual text (the view drops
  them on Vim). Nothing a reader needs may exist only in virtual text when `virtual === false`.

## Invariants

- dom, css, style, layout and interact never touch nvim, keep no module-level mutable state and never throw on
  real-world input (bad CSS drops the declaration, odd HTML is repaired).
- Content is never dropped silently nor duplicated: every text node lands in `lines` exactly once (or in a code
  region), except `display: none` / `visibility: hidden` subtrees.
- virtText, virtLines and conceals are optional in `Layout`; layoutBoxes always fills them (possibly empty).
- Every `paint` group name appears in `StyledTree.groups`; role groups `HtmlViewHost<Role>` link down their native
  chain (`host.ts`; borders → FloatBorder → WinSeparator → NonText; link URL → @markup.link.url → Underlined →
  Directory). Literal CSS colours stay true colour, alpha blended by the view.
- highlight: `highlightRegions` is pure and returns marks only inside the given regions, priority within the `code`
  band, groups only from `groupForClass`; `treesitterRegions` never throws (returns `handled: []` on Vim or failure)
  and only touches region lines in the given namespace.
- view: buffer `nofile`/`nomodifiable`, `q` closes, reuse by name; defines groups (the `--vscode-*` variable links
  with default semantics are the user's override point; stylesheet groups are redefined in full on each update) and
  redefines them on ColorScheme; converts cells to bytes; calls `refresh` for open, resize, context selection,
  ColorScheme and `background` changes; a refresh that finishes after a newer view reused the buffer applies nothing.

## Known limitations

- `::before` / `::after` content on a block is not rewrapped with the block's text.
- Backgrounds of non-code elements are clipped to their text, not painted over the full box.
- `rowspan` is ignored in tables.
- Flex is row only: `flex-wrap`, `gap` and `inline-flex` are not computed, so `nowrap` wraps too and an inline-flex
  container shrinks only as a flex item or an atomic inline.

## Testing

`npm test` bundles every `tests/**/*.test.ts` (mirroring `src/`) with esbuild into `.cache/test` and runs `node --test`, with
`node:test` and `node:assert/strict`; fixtures through `tests/fixtures/index.ts` (`loadFixture(name)`). The engine,
highlight-hljs and convert need no nvim. `npx tsc --noEmit -p .` must not add errors (baseline: 24 unrelated errors
outside htmlview).

Acceptance checks:

1. **Firefox oracle.** `tests/fixtures/oracle/<name>.json` holds per element (path
   `tag#id.cls:nth-child(k)>…`) the computed `display, color, background-color, font-weight, font-style,
   text-decoration-line, white-space, list-style-type, margin-*, padding-*, border-*-style`, plus `::before`/`::after`
   content, from Firefox's UA + VS Code webview compatibility defaults + the adapter's sheets, body `vscode-dark`.
   `--vscode-*` are sentinel colours (`oracle/vars.json`): a computed `rgb(1, hi, lo)` means "this host variable",
   which the engine expresses as the matching `{var}` colour / `HtmlView<Var>` group. Style must agree with every
   oracle element (display; colour source; weight ≥ 600 ⇔ bold; italic; decoration lines; white-space;
   list-style-type; non-zero margins/padding/borders ⇔ non-zero cells); layout must show what those styles imply.
   Re-capture after a fixture or sheet change: `node scripts/oracle/capture.mjs [name ...]` (needs `firefox`).
2. **Parity.** `node scripts/parity/build.mjs && node scripts/parity/analyze.cjs 100 out.json --new
   scripts/parity/engine.cjs`: the engine must not lose text, structure or colour the earlier renderer had.
3. Unit tests per folder, `npm run build`, `npx tsc --noEmit -p .` at or below the baseline.
