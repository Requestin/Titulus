import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeP20Evidence,
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
