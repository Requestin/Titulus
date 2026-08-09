import assert from 'node:assert/strict';
import test from 'node:test';

import { attributeSemanticAnomalies } from '../lib/analyze-p20-attribution.mjs';

test('attributes odd-field duplicate to DeckLink single and preceding CEF timeout', () => {
  const report = attributeSemanticAnomalies({
    anomalies: [{
      kind: 'duplicate',
      unixUs: 1_000_000,
      fieldIndex: 101,
      fieldParity: 'odd',
    }],
    scheduleRows: [{
      event: 'schedule',
      unix_us: '990000',
      schedule_seq: '7',
      fresh_count: '1',
      woven_a: '42',
      woven_b: '42',
      weave_mode: 'single',
    }],
    frameRows: [{
      unix_us: '985000',
      begin_frame_token: '88',
      wait_exit_reason: 'timeout',
      cef_seq_at_send: '40',
      cef_paint_after: '40',
      publish_seq_after: '42',
    }],
  });

  assert.equal(report.attributions.length, 1);
  assert.equal(report.attributions[0].classification, 'decklink_underflow_after_cef_timeout');
  assert.equal(report.attributions[0].schedule.weaveMode, 'single');
  assert.equal(report.attributions[0].frame.waitExitReason, 'timeout');
});

test('keeps clean pair anomaly explicitly unattributed instead of inventing causality', () => {
  const report = attributeSemanticAnomalies({
    anomalies: [{ kind: 'reversed', unixUs: 2_000_000, fieldIndex: 202 }],
    scheduleRows: [{
      event: 'schedule',
      unix_us: '1995000',
      schedule_seq: '8',
      fresh_count: '2',
      woven_a: '50',
      woven_b: '51',
      weave_mode: 'pair',
    }],
    frameRows: [],
  });

  assert.equal(report.attributions[0].classification, 'wire_or_field_order_unattributed');
});
