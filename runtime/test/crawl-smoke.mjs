// runtime/test/crawl-smoke.mjs
// Offline smoke checks for crawl schedule / pause / continuous / whitespace.
// Run: cd runtime && npm test
// Uses local esbuild only — no npx / no network.

import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, 'crawl-smoke-entry.ts');
const outDir = await mkdtemp(join(tmpdir(), 'titulus-crawl-smoke-'));
const outfile = join(outDir, 'crawl-smoke.mjs');

try {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node20'],
    logLevel: 'silent',
  });

  const result = spawnSync(process.execPath, [outfile], {
    encoding: 'utf8',
    env: process.env,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
} finally {
  await rm(outDir, { recursive: true, force: true });
}
