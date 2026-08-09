import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeP20M0,
  parseDecklinkEvents,
} from '../lib/analyze-p20-m0.mjs';

const header = [
  'schema_version,event,schedule_seq,unix_us,mono_us,display_time,time_scale,',
  'queue_depth_before,fresh_count,popped_a,popped_b,woven_a,woven_b,',
  'weave_mode,result,reference_state',
].join('');

function events(lines) {
  return parseDecklinkEvents([header, ...lines].join('\n'));
}

test('accepts contiguous schedule/completion provenance with a bounded shutdown tail', () => {
  const report = analyzeP20M0({
    eventRows: events([
      '1,completion,0,1,1,0,0,0,0,0,0,0,0,starved,0,0',
      '1,completion,0,1,1,0,0,0,0,0,0,0,0,starved,0,0',
      '1,completion,0,1,1,0,0,0,0,0,0,0,0,starved,0,0',
      '1,schedule,1,1,1,0,25000,2,2,10,11,10,11,pair,0,1',
      '1,completion,1,2,2,0,0,0,0,0,0,0,0,starved,0,0',
      '1,schedule,2,3,3,0,25000,2,2,12,13,12,13,pair,0,1',
      '1,completion,2,4,4,0,0,0,0,0,0,0,0,starved,0,0',
      '1,schedule,3,5,5,0,25000,2,2,14,15,14,15,pair,0,1',
      '1,schedule,4,6,6,0,25000,2,2,16,17,16,17,pair,0,1',
    ]),
    engineLog: 'telemetry in=99 scheduled=99 late=0 dropped=0 flushed=0 overwrite=0 starved=0 pairs=99 singles=0 event_overflow=0\nduration reached, shutting down\n',
  });

  assert.equal(report.healthy, true);
  assert.equal(report.schedules, 4);
  assert.equal(report.completions, 2);
  assert.equal(report.prerollCompletions, 3);
  assert.equal(report.loggerIntegrity.healthy, true);
  assert.equal(report.deliveryHealth.healthy, true);
  assert.deepEqual(report.shutdownTail, [3, 4]);
  assert.deepEqual(report.errors, []);
});

test('fails for an interior completion gap, nonzero delivery errors, or logger overflow', () => {
  const report = analyzeP20M0({
    eventRows: events([
      '1,completion,0,1,1,0,0,0,0,0,0,0,0,starved,0,0',
      '1,completion,0,1,1,0,0,0,0,0,0,0,0,starved,0,0',
      '1,completion,0,1,1,0,0,0,0,0,0,0,0,starved,0,0',
      '1,schedule,1,1,1,0,25000,2,2,10,11,10,11,pair,0,1',
      '1,completion,1,2,2,0,0,0,0,0,0,0,0,starved,0,0',
      '1,schedule,2,3,3,0,25000,2,2,12,13,12,13,pair,0,1',
      '1,schedule,3,4,4,0,25000,2,2,14,15,14,15,pair,0,1',
      '1,completion,3,5,5,0,0,0,0,0,0,0,0,starved,0,0',
    ]),
    engineLog: 'telemetry in=99 scheduled=99 late=1 dropped=0 flushed=0 overwrite=0 starved=0 pairs=99 singles=0 event_overflow=2\n',
  });

  assert.equal(report.healthy, false);
  assert.equal(report.loggerIntegrity.healthy, false);
  assert.equal(report.deliveryHealth.healthy, false);
  assert.match(report.errors.join('\n'), /missing completion for schedule_seq=2/);
  assert.match(report.errors.join('\n'), /late=1/);
  assert.match(report.errors.join('\n'), /event_overflow=2/);
});

test('rejects malformed provenance rows and non-adjacent woven pair source IDs', () => {
  assert.throws(
    () => events([
      '1,schedule,1,1',
      '1,completion,1,2,2,0,0,0,0,0,0,0,0,starved,0,0',
    ]),
    /incomplete DeckLink event row/,
  );

  const report = analyzeP20M0({
    eventRows: events([
      '1,schedule,1,1,1,0,25000,2,2,10,11,10,11,pair,0,1',
      '1,completion,1,2,2,0,0,0,0,0,0,0,0,starved,0,0',
      '1,schedule,2,3,3,0,25000,2,2,14,16,14,16,pair,0,1',
      '1,completion,2,4,4,0,0,0,0,0,0,0,0,starved,0,0',
    ]),
    engineLog: 'telemetry in=2 scheduled=2 late=0 dropped=0 flushed=0 overwrite=0 starved=0 pairs=2 singles=0 event_overflow=0\n',
  });
  assert.match(report.errors.join('\n'), /does not contain adjacent source IDs/);
});

test('accepts source gaps only when matching input-overwrite events prove their loss', () => {
  const report = analyzeP20M0({
    eventRows: events([
      '1,completion,0,1,1,0,0,0,0,0,0,0,0,starved,0,0',
      '1,completion,0,1,1,0,0,0,0,0,0,0,0,starved,0,0',
      '1,completion,0,1,1,0,0,0,0,0,0,0,0,starved,0,0',
      '1,schedule,1,1,1,0,25000,2,2,10,11,10,11,pair,0,1',
      '1,completion,1,2,2,0,0,0,0,0,0,0,0,starved,0,0',
      '1,input_overwrite,0,3,3,0,0,0,0,12,0,0,0,starved,0,0',
      '1,input_overwrite,0,4,4,0,0,0,0,13,0,0,0,starved,0,0',
      '1,schedule,2,5,5,0,25000,2,2,14,15,14,15,pair,0,1',
      '1,completion,2,6,6,0,0,0,0,0,0,0,0,starved,0,0',
    ]),
    engineLog: 'telemetry in=4 scheduled=2 late=0 dropped=0 flushed=0 overwrite=2 starved=0 pairs=2 singles=0 event_overflow=0\n',
  });

  assert.equal(report.healthy, true);
  assert.equal(report.telemetry.overwrite, 2);
});

test('rejects event rows whose clock order cannot support a timeline join', () => {
  assert.throws(
    () => events([
      '1,schedule,1,10,20,0,25000,2,2,10,11,10,11,pair,0,1',
      '1,completion,1,9,21,0,0,0,0,0,0,0,0,starved,0,0',
    ]),
    /unix_us is not non-decreasing/,
  );
});

test('requires three preroll completions and a graceful marker for a shutdown tail', () => {
  const report = analyzeP20M0({
    eventRows: events([
      '1,completion,0,1,1,0,0,0,0,0,0,0,0,starved,0,0',
      '1,schedule,1,2,2,0,25000,2,2,10,11,10,11,pair,0,1',
    ]),
    engineLog: 'telemetry in=1 scheduled=1 late=0 dropped=0 flushed=0 overwrite=0 starved=0 pairs=1 singles=0 event_overflow=0\n',
  });

  assert.equal(report.healthy, false);
  assert.match(report.errors.join('\n'), /expected 3 preroll completions/);
  assert.match(report.errors.join('\n'), /graceful shutdown marker/);
});

test('rejects a frozen producer even when DeckLink completions are error-free', () => {
  const report = analyzeP20M0({
    eventRows: events([
      '1,completion,0,1,1,0,0,0,0,0,0,0,0,starved,0,0',
      '1,completion,0,1,1,0,0,0,0,0,0,0,0,starved,0,0',
      '1,completion,0,1,1,0,0,0,0,0,0,0,0,starved,0,0',
      '1,schedule,1,10,10,0,25000,0,0,0,0,0,0,starved,0,1',
      '1,completion,1,11,11,0,0,0,0,0,0,0,0,starved,0,1',
    ]),
    engineLog: [
      'frames=0',
      'telemetry5s in_fps=0.0 out_fps=25.0 queue=0 d_pairs=0 d_singles=0 d_starved=125 d_late=0 d_dropped=0 d_flushed=0 d_overwritten=0 ref=locked',
      'telemetry in=0 scheduled=1 late=0 dropped=0 flushed=0 overwrite=0 starved=1 pairs=0 singles=0 event_overflow=0',
    ].join('\n'),
    measurementStartUnixUs: 5,
  });

  assert.equal(report.healthy, false);
  assert.equal(report.loggerIntegrity.healthy, true);
  assert.equal(report.deliveryHealth.healthy, true);
  assert.equal(report.renderLiveness.healthy, false);
  assert.equal(report.cadenceHealth.healthy, false);
  assert.match(report.errors.join('\n'), /render produced zero frames|measurement contains starved schedule/);
});

test('separates startup starvation from strict measurement cadence health', () => {
  const report = analyzeP20M0({
    eventRows: events([
      '1,completion,0,1,1,0,0,0,0,0,0,0,0,starved,0,0',
      '1,completion,0,1,1,0,0,0,0,0,0,0,0,starved,0,0',
      '1,completion,0,1,1,0,0,0,0,0,0,0,0,starved,0,0',
      '1,schedule,1,2,2,0,25000,0,0,0,0,0,0,starved,0,1',
      '1,completion,1,3,3,0,0,0,0,0,0,0,0,starved,0,1',
      '1,schedule,2,10,10,0,25000,2,2,10,11,10,11,pair,0,1',
      '1,completion,2,11,11,0,0,0,0,0,0,0,0,starved,0,1',
    ]),
    engineLog: [
      'frames=2',
      'telemetry in=2 scheduled=2 late=0 dropped=0 flushed=0 overwrite=0 starved=1 pairs=1 singles=0 event_overflow=0',
    ].join('\n'),
    measurementStartUnixUs: 5,
  });

  assert.equal(report.healthy, true);
  assert.equal(report.renderLiveness.healthy, true);
  assert.deepEqual(report.cadenceHealth.measurementModes, {
    pair: 1,
    single: 0,
    starved: 0,
  });
});
