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

- A real CSS cascade: a built-in user-agent sheet, the caller's
  stylesheets, the document's `<style>` blocks and `style=""` attributes,
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
        stylesheets: ["/abs/path/to/my.css"],
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
| `htmlview.stylesheets` | string[] | `[]` | Extra CSS files applied to every view after the calling extension's stylesheets, so their rules win. `~` and environment variables are expanded; relative paths resolve against the workspace root. |
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
role with `:hi` to restyle every view. The role table, the per-rule groups
and how overrides survive a colorscheme change are in
`:help coc-htmlview-highlights`.

## Known limitations

- `::before`/`::after` content on a block is not rewrapped with the block's
  text.
- Backgrounds of non-code elements cover their text only, not the full box.
- `rowspan` is ignored in tables.
- Flex is row only; `flex-wrap`, `gap` and `inline-flex` are not computed.
- No fonts or font sizes: headings are colours and markers, weight 600 or
  more is bold.
- Form controls other than radio and checkbox are not rendered; images show
  their `alt` text.

## Development

```sh
npm ci
npm run build     # lib/index.js and lib/api.d.ts
npm test          # unit tests
npm run typecheck
```

## License

MIT, see [LICENSE](LICENSE).
