// Golden snapshot of htmlview's output (not shipped): `node scripts/golden/dump.mjs <outdir>` (default .cache/golden/cur).
// Bundles entry.ts with htmlview's `open` replaced by view-shim.ts, then runs it from the repo root. Compare two dumps
// with `diff -r <a> <b>`.
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const bundle = resolve(root, '.cache/golden/entry.js');
await esbuild.build({
  entryPoints: [resolve(here, 'entry.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs',
  loader: { '.css': 'text', '.lua': 'text' }, external: ['coc.nvim'], logLevel: 'warning',
  plugins: [{ name: 'view-shim', setup(b) {
    b.onResolve({ filter: /^\.\/view$/ }, (a) => (a.importer === resolve(root, 'src/render.ts') ? { path: resolve(here, 'view-shim.ts') } : undefined));
  } }],
});
const outdir = resolve(process.argv[2] ?? resolve(root, '.cache/golden/cur'));
const result = spawnSync(process.execPath, [bundle, outdir], { stdio: 'inherit', cwd: root });
process.exit(result.status ?? 1);
