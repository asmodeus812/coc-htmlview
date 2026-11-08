# htmlview fixtures

Hand-written HTML inputs for parse, style, layout and interaction tests. Load them with `loadFixture(name)` /
`listFixtures()` from `./index.ts` (tests run from the repo root).

| File | Covers |
|---|---|
| `demo-rich.html` | a generic page with its own embedded stylesheet and `<head>`: headings, lists, tables, code, links, details; golden input, no oracle |
| `tabs-contexts.html` | radio-driven tabs with a nested group of context tabs (`tab-0`, `context-0`, `context-1`, groups `tabs` and `contextualTabs`, defaults checked: tab-0 and context-1); used by the interaction tests |
| `edge-pre-in-li.html` | `<pre>` inside `<li>` (with a tab-indented line), `<pre><code>` in a nested list |
| `edge-mixed-li.html` | loose inline + `<p>` + inline + `<br>` + `<blockquote>` with bare inline in one `<li>`; empty `<li>`; `#anchor` link |
| `edge-entities.html` | `&rarr; &mdash; &lt; &amp; &hellip; &nbsp; &#8203; &#x2713;`; `&amp;#39;` must decode ONCE to the literal text `&#39;`; entities in `<pre>` |
| `edge-widths.html` | CJK/Hangul (2 cells), emoji (2 cells), combining accent (0 cells), wide chars in code |
| `edge-wide-table.html` | table wider than any window: long unbreakable cell content, colspan row |

## Browser oracle (`oracle/`)

`oracle/<name>.json` for every `edge-*` fixture: the computed styles headless Firefox gives each element with
Firefox's own UA sheet and VS Code's webview default styles (no extra sheets), body class `vscode-dark`;
`oracle/vars.json` maps every `--vscode-*` variable to the sentinel colour it was given. The engine's primary
acceptance check (see `src/CONTRACT.md`). Re-run after changing a fixture, from the repo root:
`node scripts/oracle/capture.mjs edge-entities edge-mixed-li edge-pre-in-li edge-wide-table edge-widths` (needs
`firefox` on PATH; the header of the script has the details).
