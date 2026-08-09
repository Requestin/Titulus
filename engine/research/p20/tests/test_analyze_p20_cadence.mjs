import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  analyzeP20Cadence,
  parseFrameLogCsv,
} from '../lib/analyze-p20-cadence.mjs';

const fixtures = new URL('./fixtures/', import.meta.url);

function fixture(name) {
  return readFileSync(new URL(name, fixtures), 'utf8');
}

test('classifies clean one-tick rAF cadence and separates motion from delivery', () => {
  const report = analyzeP20Cadence(parseFrameLogCsv(fixture('p20-cadence-clean-11.csv')));

  assert.equal(report.schemaVersion, 'p20-cadence-v1');
  assert.equal(report.runtimeEvents, 5);
  assert.deepEqual(report.tickPairDistribution, {
    total: 4,
    oneOne: 1,
    twoZero: 0,
    other: 0,
    pairs: { '(1,1)': 4 },
  });
  assert.equal(report.logicalMotion.poseRate, 50);
  assert.equal(report.cefPaint.rate, 50);
  assert.equal(report.publish.rate, 50);
});

test('detects systematic two-zero semantic cadence despite a 50Hz delivery stream', () => {
  const report = analyzeP20Cadence(parseFrameLogCsv(fixture('p20-cadence-systematic-20.csv')));

  assert.deepEqual(report.tickPairDistribution, {
    total: 4,
    oneOne: 0,
    twoZero: 1,
    other: 0,
    pairs: { '(0,2)': 2, '(2,0)': 2 },
  });
  assert.equal(report.logicalMotion.poseRate, 25);
  assert.equal(report.cefPaint.rate, 50);
  assert.equal(report.publish.rate, 50);
});

test('excludes startup rows before the supplied measurement boundary', () => {
  const rows = parseFrameLogCsv(fixture('p20-cadence-mixed-warmup.csv'));
  const report = analyzeP20Cadence(rows, { warmupUnixUs: 1_040_000 });

  assert.equal(report.sourceRows, 7);
  assert.equal(report.measuredRows, 5);
  assert.equal(report.runtimeEvents, 5);
  assert.equal(report.tickPairDistribution.oneOne, 1);
  assert.equal(report.logicalMotion.poseRate, 50);
});

test('excludes controlled shutdown rows after the supplied measurement end', () => {
  const rows = parseFrameLogCsv(fixture('p20-cadence-mixed-warmup.csv'));
  const report = analyzeP20Cadence(rows, {
    warmupUnixUs: 1_040_000,
    measurementEndUnixUs: 1_100_000,
  });

  assert.equal(report.measuredRows, 3);
  assert.equal(report.runtimeEvents, 3);
  assert.equal(report.measurement.startUnixUs, 1_040_000);
  assert.equal(report.measurement.endUnixUs, 1_080_000);
  assert.equal(report.logicalMotion.poseRate, 50);
});

test('discards only an incomplete final CSV row from controlled shutdown', () => {
  const rows = parseFrameLogCsv(
    `${fixture('p20-cadence-clean-11.csv').trim()}\n2,1100000,600000,0,6`,
  );
  const report = analyzeP20Cadence(rows);

  assert.equal(rows.trailingPartialRows, 1);
  assert.equal(report.sourceRows, 5);
  assert.equal(report.trailingPartialRows, 1);
});

test('fails closed for missing or contradictory runtime provenance', () => {
  assert.throws(
    () => parseFrameLogCsv(fixture('p20-cadence-missing-provenance.csv')),
    /requires runtime_event_seq/,
  );

  const contradictory = parseFrameLogCsv(fixture('p20-cadence-clean-11.csv'));
  contradictory.splice(1, 0, { ...contradictory[0], ticks_per_raf: '2' });
  assert.throws(
    () => analyzeP20Cadence(contradictory),
    /contradictory duplicate runtime_event_seq/,
  );
});
