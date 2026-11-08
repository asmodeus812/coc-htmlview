// Runs the unit tests: bundles every *.test.ts under the roots below with esbuild into .cache/test, then runs
// them with the built-in `node --test`. No test framework dependency. Extra arguments go to `node --test`
// (e.g. `npm test -- --test-name-pattern=layout`).
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// every test under src
const roots = ['src'];
const outbase = 'src';
const outdir = '.cache/test';

function findTests(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? findTests(full) : name.endsWith('.test.ts') ? [full] : [];
  });
}

const entryPoints = roots.flatMap(findTests);
rmSync(outdir, { recursive: true, force: true });
await esbuild.build({
  entryPoints,
  outdir,
  outbase,
  bundle: true,
  platform: 'node',
  loader: { '.css': 'text', '.lua': 'text' },
  target: 'node18',
  format: 'cjs',
  sourcemap: 'inline',
  external: ['coc.nvim'],
  logLevel: 'warning',
});

const files = entryPoints.map((f) => join(outdir, relative(outbase, f)).replace(/\.ts$/, '.js'));
const result = spawnSync(process.execPath, ['--enable-source-maps', '--test', ...process.argv.slice(2), ...files], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
