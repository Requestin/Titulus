import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeP20Evidence,
  validateCaptureBinding,
  validateCaptureSummary,
  validateRunMetadata,
} from '../lib/analyze-p20-evidence.mjs';

function healthyM0() {
  return {
    healthy: true,
    errors: [],
    renderLiveness: { healthy: true, errors: [] },
    cadenceHealth: { healthy: true, errors: [] },
  };
}

function semantic({ healthy = true } = {}) {
  return {
    schemaVersion: 'p20-semantic-fields-v1',
    fieldRows: 4,
    totals: {
      decoded: 4,
      duplicate: healthy ? 0 : 1,
      skipped: 0,
      reversed: 0,
      undecodable: 0,
      parityMismatch: 0,
    },
    healthy,
  };
}

test('joint evidence requires M0, semantic cadence, and advancing frame provenance', () => {
  const report = analyzeP20Evidence({
    m0Report: healthyM0(),
    semanticReport: semantic(),
    frameRows: [
      { cef_paint_after: '10', publish_seq_after: '20', logical_frame_after: '30' },
      { cef_paint_after: '11', publish_seq_after: '21', logical_frame_after: '31' },
    ],
  });

  assert.equal(report.healthy, true);
  assert.deepEqual(report.errors, []);
  assert.equal(report.planes.frameLiveness.healthy, true);
});

test('joint evidence fails a frozen frame stream or semantic anomaly despite healthy delivery', () => {
  const report = analyzeP20Evidence({
    m0Report: healthyM0(),
    semanticReport: semantic({ healthy: false }),
    frameRows: [
      { cef_paint_after: '10', publish_seq_after: '20', logical_frame_after: '30' },
      { cef_paint_after: '10', publish_seq_after: '20', logical_frame_after: '30' },
    ],
  });

  assert.equal(report.healthy, false);
  assert.equal(report.planes.delivery.healthy, true);
  assert.equal(report.planes.semantic.healthy, false);
  assert.equal(report.planes.frameLiveness.healthy, false);
  assert.match(report.errors.join('\n'), /duplicate=1/);
  assert.match(report.errors.join('\n'), /CEF paint sequence did not advance/);
});

test('frame liveness accepts a looping logical sequence that ends on its start value', () => {
  const report = analyzeP20Evidence({
    m0Report: healthyM0(),
    semanticReport: semantic(),
    frameRows: [
      { cef_paint_after: '10', publish_seq_after: '20', logical_frame_after: '0' },
      { cef_paint_after: '11', publish_seq_after: '21', logical_frame_after: '1' },
      { cef_paint_after: '12', publish_seq_after: '22', logical_frame_after: '0' },
    ],
  });
  assert.equal(report.planes.frameLiveness.healthy, true);
});

test('run metadata requires completed execution, measurement bounds, and matching digest', () => {
  const valid = {
    manifest: {
      runId: 'run-1',
      configDigest: 'abc',
      execution: { mode: 'execute' },
      measurement: { startUnixUs: 100, endUnixUs: 200 },
    },
    channelManifest: { runId: 'run-1', configDigest: 'abc' },
    runStatus: {
      outcome: 'completed',
      runId: 'run-1',
      configDigest: 'abc',
      measurement: { startUnixUs: 100, endUnixUs: 200 },
    },
  };
  assert.equal(validateRunMetadata(valid).healthy, true);
  assert.equal(validateRunMetadata({
    ...valid,
    runStatus: { outcome: 'aborted' },
  }).healthy, false);
  assert.equal(validateRunMetadata({
    ...valid,
    manifest: { ...valid.manifest, execution: { mode: 'dry_run' } },
  }).healthy, false);
  assert.equal(validateRunMetadata({
    ...valid,
    channelManifest: { configDigest: 'def' },
  }).healthy, false);
});

test('capture binding requires one expected stream fully inside measurement window', () => {
  const rows = [
    { unix_us: '102', output_channel: 'ch1', capture_input: 'port6' },
    { unix_us: '198', output_channel: 'ch1', capture_input: 'port6' },
  ];
  const expected = {
    measurement: { startUnixUs: 100, endUnixUs: 200 },
    outputChannel: 'ch1',
    captureInput: 'port6',
    coverageToleranceUs: 5,
  };
  assert.equal(validateCaptureBinding(rows, expected).healthy, true);
  assert.equal(validateCaptureBinding(
    [{ ...rows[0], output_channel: 'other' }, rows[1]],
    expected,
  ).healthy, false);
  assert.equal(validateCaptureBinding(
    [...rows, { ...rows[1], unix_us: '206' }],
    expected,
  ).healthy, false);
  assert.equal(validateCaptureBinding(
    [{ ...rows[0], unix_us: '110' }, { ...rows[1], unix_us: '190' }],
    expected,
  ).healthy, false);
});

test('capture summary must be healthy, complete, and bound to the same run', () => {
  const expected = {
    runId: 'run-1',
    configDigest: 'abc',
    fields: 100,
  };
  const summary = {
    schemaVersion: 'p20-field-capture-summary-v1',
    runId: 'run-1',
    configDigest: 'abc',
    fields: 100,
    noSource: 0,
    invalid: 0,
    writeFailures: 0,
    csvFlush: true,
    healthy: true,
  };
  assert.equal(validateCaptureSummary(summary, expected).healthy, true);
  assert.equal(validateCaptureSummary({ ...summary, noSource: 1 }, expected).healthy, false);
  assert.equal(validateCaptureSummary({ ...summary, runId: 'other' }, expected).healthy, false);
  assert.equal(validateCaptureSummary({ ...summary, fields: 99 }, expected).healthy, false);
});
