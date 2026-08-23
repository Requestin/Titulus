import assert from 'node:assert/strict';
import test from 'node:test';

import { continueCommand, isWaitingContinue } from './onAirContinue';

test('isWaitingContinue reads the versioned details sibling', () => {
  const details = {
    schemaVersion: 'onair-details-v1' as const,
    channels: {
      ch1: [{ templateId: 'tpl', waitingContinue: true }],
    },
  };
  assert.equal(isWaitingContinue(details, 'ch1', 'tpl'), true);
  assert.equal(isWaitingContinue(details, 'ch1', 'other'), false);
  assert.equal(isWaitingContinue(null, 'ch1', 'tpl'), false);
});

test('continueCommand is ACK-compatible and has no extra fields', () => {
  assert.deepEqual(continueCommand('ch1', 'tpl'), {
    type: 'continue',
    channelId: 'ch1',
    templateId: 'tpl',
  });
});
