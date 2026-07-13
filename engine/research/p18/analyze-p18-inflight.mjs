#!/usr/bin/env node
/**
 * Phase 18 P0.2: summarise paint_seq_delta / inflight_depth from a frame-log
 * produced under BG_P18_PIPELINE_PROBE=1.
 *
 * Usage:
 *   node engine/research/p18/analyze-p18-inflight.mjs --in=frame-log.csv [--out=report.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

const inPath = arg('in', '');
const outPath = arg('out', '');
if (!inPath) {
  console.error('Usage: analyze-p18-inflight.mjs --in=frame-log.csv [--out=report.json]');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const analyzer = join(here, '../lib/analyze-frame-log.mjs');
const tmpJson = outPath || `/tmp/p18-inflight-${Date.now()}.json`;
const r = spawnSync(process.execPath, [analyzer, `--in=${inPath}`, `--out=${tmpJson}`], {
  encoding: 'utf8',
});
process.stdout.write(r.stdout || '');
if (r.status !== 0) {
  process.stderr.write(r.stderr || '');
  process.exit(r.status || 1);
}

const report = JSON.parse(readFileSync(tmpJson, 'utf8'));
const pct = report.pctTicksDeltaGe2 ?? 0;
let verdict;
if (pct >= 50) verdict = 'APPROACH_A';
else if (pct < 5) verdict = 'APPROACH_B_OR_FALLBACK';
else verdict = 'PARTIAL';

const summary = {
  ...report,
  decisionHint: verdict,
  decisionRule:
    'pctTicksDeltaGe2>=50 → Approach A (pipeline); <5 → B/Fallback; else partial',
};

console.log('');
console.log(`Decision hint: ${verdict} (pctTicksDeltaGe2=${pct}%)`);
console.log(summary.decisionRule);

if (outPath) {
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`[analyze-p18-inflight] wrote ${outPath}`);
}
