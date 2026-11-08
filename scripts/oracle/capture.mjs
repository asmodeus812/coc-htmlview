// Firefox oracle: the computed styles a real browser gives every fixture, the engine's PRIMARY acceptance check.
//
// Usage (from the repo root): node scripts/oracle/capture.mjs [name ...]   (no names: every fixture)
//
// For each `tests/fixtures/*.html` it
// loads a page in headless Firefox over WebDriver BiDi (node's built-in WebSocket, no dependency) that stacks, as
// VS Code's webview does: Firefox's own UA sheet (the browser equivalent of engine/style/ua.css), VS Code's webview
// default styles (vscode-webview-defaults.css, verbatim), then the document's own styles (no extra sheets). `body` gets class `vscode-dark`. Every
// `--vscode-*` variable is defined as a distinct SENTINEL colour (`rgb(1, hi, lo)`, map in oracle/vars.json), so a
// computed colour tells which host variable fed it; font variables get plain values.
// Output: tests/fixtures/oracle/<name>.json = { name, firefox, sheets, elements: [{ path, tag, id?, class?,
// style: {prop: value}, before?, after?, marker? }]
// (marker: only an explicit `::marker { content }`; Firefox reports `normal` for list-style markers, see list-style-type) }, elements in document order (html, body and body's subtree).
// Only the Firefox process this script starts is stopped (browser.close, then SIGTERM/SIGKILL of that child), and
// its temporary profile (under .cache/oracle/, the snap Firefox cannot read /tmp) is removed.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import * as esbuild from 'esbuild';

const root = process.cwd();
const fixturesDir = resolve(root, 'tests/fixtures');
const outDir = join(fixturesDir, 'oracle');
const cacheDir = resolve(root, '.cache/oracle');
const PROPS = [
  'display', 'color', 'background-color', 'font-weight', 'font-style', 'text-decoration-line', 'white-space',
  'list-style-type',
  ...['top', 'right', 'bottom', 'left'].flatMap((s) => [`margin-${s}`, `padding-${s}`, `border-${s}-style`]),
];
const TIMEOUT_MS = 180000;

function inputs(only) {
  const names = readdirSync(fixturesDir).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5)).sort();
  const all = names.map((n) => ({ name: n, html: readFileSync(join(fixturesDir, n + '.html'), 'utf8') }));
  return all.filter((i) => only.length === 0 || only.includes(i.name));
}

// every host variable any sheet or input references → a sentinel value
function variables(texts) {
  const names = new Set();
  for (const t of texts) for (const m of t.matchAll(/--vscode-[A-Za-z0-9-]+/g)) names.add(m[0]);
  const vars = { '--monaco-monospace-font': 'monospace', '--text-link-decoration': 'none' };
  [...names].sort().forEach((n, i) => {
    const k = i + 1;
    vars[n] = /font-family/.test(n) ? 'sans-serif' : /font-weight/.test(n) ? 'normal' : /font-size/.test(n) ? '13px' : `rgb(1, ${k >> 8}, ${k & 255})`;
  });
  return vars;
}

function page(input, vars, webview, sheets) {
  const decl = Object.entries(vars).map(([k, v]) => `${k}: ${v};`).join(' ');
  const styles = [`:root { ${decl} }`, webview, ...sheets.map((s) => s.text)].map((t) => `<style>${t}</style>`).join('');
  // a complete document (its own <head>) is loaded as the document, so head-level elements stay out of the body
  const full = /<head[\s>]/i.test(input.html);
  return full
    ? input.html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}<meta charset="utf-8">${styles}`)
    : `<!doctype html><html><head><meta charset="utf-8">${styles}</head><body class="vscode-dark">${input.html}</body></html>`;
}

// runs in the page: path, attributes, computed PROPS and pseudo content per element
const DUMP = `(() => {
  const props = ${JSON.stringify(PROPS)};
  document.body.classList.add('vscode-dark');
  const step = (e) => {
    const sibs = e.parentElement ? [...e.parentElement.children] : [e];
    const cls = [...e.classList].map((c) => '.' + c).join('');
    return e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + cls + ':nth-child(' + (sibs.indexOf(e) + 1) + ')';
  };
  const path = (e) => { const p = []; for (let x = e; x; x = x.parentElement) p.unshift(step(x)); return p.join('>'); };
  const pseudo = (e, which) => { const c = getComputedStyle(e, which).content; return c === 'none' || c === 'normal' ? undefined : c; };
  const els = [document.documentElement, document.body, ...document.body.querySelectorAll('*')].filter((e) => !['STYLE', 'SCRIPT'].includes(e.tagName));
  return JSON.stringify(els.map((e) => {
    const s = getComputedStyle(e);
    const style = {};
    for (const p of props) style[p] = s.getPropertyValue(p);
    const o = { path: path(e), tag: e.tagName.toLowerCase() };
    if (e.id) o.id = e.id;
    if (e.className && typeof e.className === 'string') o.class = e.className;
    o.style = style;
    const b = pseudo(e, '::before'); if (b !== undefined) o.before = b;
    const a = pseudo(e, '::after'); if (a !== undefined) o.after = a;
    if (s.display === 'list-item') { const m = pseudo(e, '::marker'); if (m !== undefined) o.marker = m; }
    return o;
  }));
})()`;

async function main() {
  const only = process.argv.slice(2);
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  const list = inputs(only);
  const webview = readFileSync(resolve(root, 'scripts/oracle/vscode-webview-defaults.css'), 'utf8');
  const vars = variables([webview, ...list.map((i) => i.html)]);

  const prof = mkdtempSync(join(cacheDir, 'profile-'));
  const ff = spawn('firefox', ['--headless', '--no-remote', '--profile', prof, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let exited = false;
  ff.on('exit', () => { exited = true; });
  let stderr = '';
  const url = new Promise((ok, fail) => {
    ff.stderr.on('data', (d) => {
      stderr += d;
      const m = /WebDriver BiDi listening on (ws:\/\/[^\s]+)/.exec(stderr);
      if (m) ok(m[1]);
    });
    ff.on('exit', (c) => fail(new Error(`firefox exited (${c}): ${stderr.slice(0, 400)}`)));
  });
  const stop = async () => {
    if (!exited) {
      ff.kill('SIGTERM');
      for (let i = 0; i < 50 && !exited; i++) await new Promise((r) => setTimeout(r, 100));
      if (!exited) ff.kill('SIGKILL');
    }
    rmSync(prof, { recursive: true, force: true });
  };
  const timer = setTimeout(() => { console.error('oracle: timeout'); stop().then(() => process.exit(2)); }, TIMEOUT_MS);

  let code = 0;
  try {
    const ws = new WebSocket((await url).replace(/\/$/, '') + '/session');
    await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error('websocket error')); });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
    const send = (method, params) => new Promise((ok, fail) => {
      const i = ++id;
      pending.set(i, (m) => (m.type === 'error' ? fail(new Error(`${method}: ${m.error} ${m.message}`)) : ok(m.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    const session = await send('session.new', { capabilities: {} });
    const firefox = `${session.capabilities.browserName} ${session.capabilities.browserVersion}`;
    const ctx = (await send('browsingContext.getTree', {})).contexts[0].context;
    for (const input of list) {
      const sheets = [];
      const html = page(input, vars, webview, sheets);
      await send('browsingContext.navigate', { context: ctx, url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html), wait: 'complete' });
      const r = await send('script.evaluate', { target: { context: ctx }, expression: DUMP, awaitPromise: false });
      const elements = JSON.parse(r.result.value);
      const out = { name: input.name, firefox, sheets: ['firefox UA', 'vscode-webview-defaults.css', ...sheets.map((s) => s.name)], elements };
      writeFileSync(join(outDir, input.name + '.json'), JSON.stringify(out, null, 1) + '\n');
      console.log(`oracle: ${input.name}: ${elements.length} elements`);
    }
    writeFileSync(join(outDir, 'vars.json'), JSON.stringify(vars, null, 1) + '\n');
    await send('browser.close', {}).catch(() => undefined);
    ws.close();
  } catch (e) {
    console.error('oracle:', e instanceof Error ? e.message : e);
    code = 1;
  }
  clearTimeout(timer);
  await stop();
  process.exit(code);
}

await main();
