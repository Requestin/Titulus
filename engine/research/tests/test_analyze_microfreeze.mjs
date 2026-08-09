import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { analyzeMicrofreeze, parseCsv } from '../lib/analyze-microfreeze.mjs';

const analyzer = new URL('../lib/analyze-microfreeze.mjs', import.meta.url);
const marker = new URL('../mark-freeze.sh', import.meta.url);
const fixtures = new URL('./fixtures/', import.meta.url);

function fixture(name) {
  return new URL(name, fixtures).pathname;
}

test('detects interval and semantic hard hitches using mono_us, clusters them, and joins unix_us evidence', () => {
  const report = analyzeMicrofreeze({
    frameRows: parseCsv(readFileSync(fixture('p20-hitches-frame.csv'), 'utf8')),
    markRows: parseCsv(readFileSync(fixture('p20-hitches-marks.csv'), 'utf8')),
    completionRows: parseCsv(readFileSync(fixture('p20-hitches-completion.csv'), 'utf8')),
    gcRows: parseCsv(readFileSync(fixture('p20-hitches-gc.csv'), 'utf8')),
    schedulerRows: parseCsv(readFileSync(fixture('p20-hitches-scheduler.csv'), 'utf8')),
  });

  assert.equal(report.frameRows, 5);
  assert.deepEqual(report.eventCounts, { soft: 1, micro: 1, hard: 2 });
  assert.equal(report.clusters.length, 3);
  assert.equal(report.clusters[0].events.length, 2);
  assert.equal(report.clusters[0].joins.completions.length, 1);
  assert.equal(report.clusters[0].joins.gc.length, 1);
  assert.equal(report.clusters[0].joins.scheduler.length, 1);
  assert.equal(report.clusters[2].reasons.includes('semantic_gap'), true);
  assert.deepEqual(report.metrics.operatorMarks, {
    freeze: { total: 1, matched: 1, matchRate: 1 },
    control: { total: 2, matched: 1, falsePositiveRate: 0.5 },
  });
});

test('separates repeating long-short cadence from isolated microfreeze clusters', () => {
  const report = analyzeMicrofreeze({
    frameRows: parseCsv(readFileSync(fixture('p20-alternating-frame.csv'), 'utf8')),
  });

  assert.equal(report.systematicAlternatingBursts.length, 1);
  assert.equal(report.systematicAlternatingBursts[0].eventCount, 3);
  assert.equal(report.clusters[0].classification, 'systematic_alternating_burst');
  assert.equal(report.clusters[0].maxIntervalUs, 40000);
});

test('refuses legacy steady wall-clock logs and refuses unix joins without unix_us', () => {
  assert.throws(
    () => analyzeMicrofreeze({
      frameRows: parseCsv('wall_clock_us,interval_us,paint_seq\n1000000,50000,1\n'),
    }),
    /mono_us/,
  );

  assert.throws(
    () => analyzeMicrofreeze({
      frameRows: parseCsv('mono_us,interval_us\n10000,50000\n'),
      markRows: parseCsv('unix_us,event\n10000,freeze\n'),
    }),
    /unix_us/,
  );
});

test('CLI emits the same JSON report from header-reordered fixture files', () => {
  const stdout = execFileSync('node', [
    analyzer.pathname,
    `--frame=${fixture('p20-hitches-frame.csv')}`,
    `--marks=${fixture('p20-hitches-marks.csv')}`,
    `--completion=${fixture('p20-hitches-completion.csv')}`,
    `--gc=${fixture('p20-hitches-gc.csv')}`,
    `--scheduler=${fixture('p20-hitches-scheduler.csv')}`,
  ], { encoding: 'utf8' });
  const report = JSON.parse(stdout);

  assert.equal(report.clusters.length, 3);
  assert.equal(report.metrics.operatorMarks.freeze.matchRate, 1);
});

test('mark-freeze writes unix_us header and captures freeze/control inputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'titulus-mark-freeze-'));
  const output = join(dir, 'marks.csv');
  const result = spawnSync('bash', [marker.pathname, output], {
    input: 'fcq',
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const rows = parseCsv(readFileSync(output, 'utf8'));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.event), ['freeze', 'control']);
  assert.ok(rows.every((row) => Number(row.unix_us) > 0));
});
