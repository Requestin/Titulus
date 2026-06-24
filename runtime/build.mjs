// runtime/build.mjs
//
// Bundle @titulus/runtime into a single IIFE script exposed as window.BG,
// consumed by:
//   - the engine channel page (backend/public/channel.html, loaded inside CEF)
//   - the editor preview (frontend) — though the editor may import ESM directly
//   - thumbnails
//
// Output: backend/public/bg-runtime.js  (gitignored — generated artifact).
//
// DEVELOPMENT_PROMPT §6.1: esbuild -> IIFE bg-runtime.js exposed as window.BG.
//
// Run:  cd runtime && npm run build

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const entry = resolve(here, 'src/index.ts');
const outdir = resolve(root, 'backend/public');
const outfile = resolve(outdir, 'bg-runtime.js');

const isWatch = process.argv.includes('--watch');
const isProd = !isWatch && process.env.NODE_ENV !== 'development';

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [entry],
  outfile,
  bundle: true,
  // IIFE so the bundle attaches to window.BG via the globalName + footer below,
  // and never pollutes the host page's module scope.
  format: 'iife',
  globalName: '__BG_INTERNAL__',
  // Expose the whole public surface (all named exports of index.ts) on window.BG.
  footer: {
    js: 'window.BG = Object.assign(window.BG || {}, __BG_INTERNAL__);',
  },
  target: ['chrome110'], // CEF 142+ ships Chromium 142; 110 is a safe floor.
  platform: 'browser',
  loader: { '.ts': 'ts' },
  logLevel: 'info',
  sourcemap: isProd ? false : 'linked',
  minify: isProd,
  legalComments: 'none',
  // The runtime is DOM-only and has no runtime npm deps, so there is nothing to
  // mark external.
};

try {
  await mkdir(outdir, { recursive: true });
} catch { /* directory may already exist */ }

if (isWatch) {
  const ctx = await build({ ...options, write: false });
  await ctx.watch();
  console.log(`[bg-runtime] watching ${entry} -> ${outfile}`);
} else {
  await build(options);
  console.log(`[bg-runtime] built ${outfile}`);
}
