# coc-htmlview

Browser-style HTML and CSS rendering into Neovim buffers, as a
[coc.nvim](https://github.com/neoclide/coc.nvim) extension. Other coc
extensions hand it an HTML string and stylesheet paths; it computes the
cascade, lays the document out for the window width and shows it in a
read-only buffer with colours taken from your colorscheme. It is built for
extension authors who have HTML to show (rule descriptions, release notes,
documentation pages) and for users who want to read that HTML inside the
editor instead of a browser.

## Features

- A real CSS cascade: a built-in user-agent sheet, your stylesheets, the
  caller's stylesheets, the document's `<style>` blocks and `style=""` attributes,
  with specificity and `!important`.
- Computed style: inheritance, `var()` with fallbacks, shorthands,
  `::before`/`::after`/`::marker` content and counters.
- Box layout on a character grid: margins, padding, borders, blocks, inline
  flow, tables, lists with markers, row flex and inline-blocks.
- Tabs and contexts through `:checked`: radio and checkbox labels act as
  tabs you switch with a key.
- Code blocks highlighted with treesitter when a parser is installed, else
  with highlight.js.
- Link targets optionally shown as virtual text next to the link
  (`htmlview.linkTargets`).
- Colours follow the colorscheme and refresh on `:colorscheme` and
  `:set background`.
- VS Code webview compatibility: the `vscode-light`/`vscode-dark` body class
  and the `--vscode-*` theme variables, mapped to Neovim highlight groups.

## Requirements

- Neovim 0.10 or newer and coc.nvim. Neovim 0.9 is the floor: it lacks
  inline virtual text, so link targets (when shown) move to the end of the
  line.
- Vim works with a reduced view: always a split, no virtual text, no
  treesitter, no refresh on resize or colorscheme change.

## Installation

From GitHub (coc runs `npm install`, which builds the extension):

```vim
:CocInstall https://github.com/asmodeus812/coc-htmlview
```

Or from a local clone:

```sh
git clone https://github.com/asmodeus812/coc-htmlview
cd coc-htmlview && npm ci && npm run build
ln -s "$PWD" ~/.config/coc/extensions/node_modules/coc-htmlview
```

## Quick start

### Users

coc-htmlview has no commands of its own. Install it next to an extension
that uses it; that extension's views then render through it. Choose where
views open and add your own stylesheets with the settings below. Inside a
view, `q` closes it, `<CR>` follows a link and `<Tab>` jumps to the next
link; `:help coc-htmlview` lists every key.

### Extension authors

```ts
import { extensions } from "coc.nvim";

const ext = extensions.getExtensionById("coc-htmlview");
const api = ext?.exports as HtmlViewApi | undefined;
if (api !== undefined && api.version === 1) {
    const view = await api.render("<h1>Hello</h1><p>From <b>HTML</b>.</p>", {
        root: context.extensionPath, // relative stylesheets resolve here
        stylesheets: ["styles/my.css"],
        view: { name: "myext://hello", reuse: true }
    });
    await view.closed;
}
```

`HtmlViewApi` and the option types are in `lib/api.d.ts`; copy the
interface into your extension, there is no compile-time dependency. The full
API, with every option, is in `:help coc-htmlview-api`.

## Configuration

| Setting | Type | Default | Effect |
|---|---|---|---|
| `htmlview.view.mode` | `"float"` \| `"split"` | `"float"` | Where views open when the calling extension does not choose: a centred float (Neovim only; Vim always splits) or a window split. |
| `htmlview.view.splitCommand` | string | `"botright vsplit"` | Ex command that creates the split, e.g. `topleft split`, `tab split`. A value that is not a split command falls back to the default with one warning. |
| `htmlview.stylesheets` | string[] | `[]` | CSS files applied to every view as your base, before the calling extension's stylesheets, so the extension's rules win over them. `~` and environment variables are expanded. Relative paths resolve against the folder of the settings file that sets them: your coc config folder for the user settings, the workspace root for the workspace settings; both lists apply, user first. Defaults declared by other extensions are ignored. |
| `htmlview.linkTargets` | boolean | `false` | Show each link's target as virtual text after the link (`` 🔗 <href>``). Off by default, as in a browser; links stay highlighted and `<CR>`/`gx` open them either way. |

Example `coc-settings.json`:

```json
{
  "htmlview.view.mode": "float",
  "htmlview.stylesheets": ["~/.config/htmlview/user.css"]
}
```

## Highlight groups

Every colour of the built-in sheet and of the `--vscode-*` variables comes
from a role group, `HtmlViewHost<Role>` (for example `HtmlViewHostLink`,
`HtmlViewHostHeading1`, `HtmlViewHostCodeBlock`), linked by default to
standard groups such as `@markup.link`, `Title` or `FloatBorder`. Override a
role with `:hi` to restyle every view. The role table, the per-rule groups,
the `HtmlViewBorder<rrggbb>` groups of literal border colours and how
overrides survive a colorscheme change are in `:help coc-htmlview-highlights`.

## Known limitations

- `::before`/`::after` content on a block is not rewrapped with the block's
  text.
- `rowspan` is ignored in tables.
- Flex is row only; `flex-wrap`, `gap` and `inline-flex` are not computed.
- No fonts or font sizes: headings are colours and markers (an inherited
  author `color` wins over the heading colour), weight 600 or
  more is bold.
- Form controls other than radio and checkbox are not rendered; images show
  their `alt` text.

## Development

```sh
npm ci
npm run build     # lib/index.js and lib/api.d.ts
npm test          # unit tests (tests/ mirrors src/)
npm run typecheck
```

### How it works

```
html ─(caller pre-pass)─▶ dom ─▶ style (UA sheet, settings sheets, caller sheets,
<style>, inline; cascade, var(), counters) ─▶ layout (boxes, inline flow, tables,
flex rows, code regions, links) ─▶ highlight (treesitter, then highlight.js) ─▶ view
```

| Part | Folder | Role |
|---|---|---|
| dom | `src/engine/dom/` | HTML parsing: implied structure, auto-closing, raw-text elements, entities |
| css | `src/engine/css/` | sheet and selector parsing, matching, cascade order |
| style | `src/engine/style/` | computed styles, the user-agent sheet `ua.css`, host roles and highlight groups |
| layout | `src/engine/layout/` | boxes and placement into lines, marks, links, anchors and virtual text |
| interact | `src/engine/interact/` | `:checked` state of radio and checkbox tabs |
| highlight | `src/highlight/` | code highlighting and the language table |
| view | `src/view/` | the only Neovim-facing part: buffer, window, groups, extmarks, keys, refresh |
| common | `src/common/` | the display-cell rules shared by every part |

`src/api.ts` is the public contract (emitted as `lib/api.d.ts`); `src/render.ts`
composes the pipeline, keeps the parsed document and restyles or lays out again
when the view reports a resize, a tab switch or a colorscheme change.

Conventions the parts rely on:

- Everything but the view is pure data in, data out: no Neovim calls, no module
  state, never throwing on real-world input (bad CSS drops the declaration, odd
  HTML is repaired). Text is never dropped or duplicated, except inside
  `display: none` and `visibility: hidden`.
- Layout never looks at a tag name or class: it reads the computed `display` and
  the `--htmlview-*` hints (`code`, `heading`, `link`, `replaced`, `toggle`,
  `break`) that `ua.css` or a stylesheet sets.
- Lines are 0-based; columns are display cells (2 for wide characters, 0 for
  combining marks) everywhere except the view, which converts to UTF-8 bytes
  for extmarks. CSS lengths become cells in style only (`ch` 1, `em` 1, `px`
  /8 across and /16 down).
- Mark priority grows with element depth, so inner elements and later rules
  win; code tokens sit above styles.

### Acceptance checks

- **Golden snapshot:** `node scripts/golden/dump.mjs <dir>` renders the fixtures
  in `tests/fixtures/` through the whole pipeline; diff two dumps to review
  every visible change.
- **Firefox oracle:** `tests/fixtures/oracle/*.json` holds Firefox's computed
  styles for the fixtures, and the oracle tests require the engine to agree.
  Re-capture after changing a fixture or `ua.css` with
  `node scripts/oracle/capture.mjs [name ...]` (needs `firefox`).

## License

MIT, see [LICENSE](LICENSE).
