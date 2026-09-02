import assert from 'node:assert/strict';
import test from 'node:test';

import {
  continueCommand,
  formatOnAirRow,
  isWaitingContinue,
  liveSlotIdSet,
  occupantForSourceLayer,
  resolveOnAirRows,
  runtimeIdForSlot,
} from './onAirContinue';

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

test('resolveOnAirRows prefers details and sorts by LayerID', () => {
  const details = {
    schemaVersion: 'onair-details-v1' as const,
    channels: {
      ch1: [
        { templateId: 'front', layerId: 90, slotId: 'front', sourceTemplateId: 'tpl-front', waitingContinue: false },
        { templateId: 'back', layerId: 10, slotId: 'slot-9', sourceTemplateId: 'tpl-back', waitingContinue: false },
      ],
    },
  };
  assert.deepEqual(
    resolveOnAirRows(details, 'ch1', ['ignored']).map((item) => item.templateId),
    ['back', 'front'],
  );
  assert.equal(
    formatOnAirRow(details.channels.ch1[1], 'Lower Third'),
    'L10 · Lower Third · slot slot-9',
  );
  assert.equal(
    formatOnAirRow({ templateId: 'front', layerId: 90, slotId: 'front', sourceTemplateId: 'front', waitingContinue: false }, 'Bug'),
    'L90 · Bug · template',
  );
});

test('Update ownership transfer keeps renderer id and highlights the new slot', () => {
  const details = {
    schemaVersion: 'onair-details-v1' as const,
    channels: {
      ch1: [{
        templateId: 'slot-spb',
        slotId: 'slot-msk',
        sourceTemplateId: 'geo',
        layerId: 50,
        waitingContinue: true,
      }],
    },
  };
  assert.deepEqual([...liveSlotIdSet(details, 'ch1', ['slot-spb'])], ['slot-msk']);
  assert.equal(runtimeIdForSlot(details, 'ch1', 'slot-msk'), 'slot-spb');
  assert.equal(isWaitingContinue(details, 'ch1', 'slot-msk'), true);
  assert.equal(occupantForSourceLayer(details, 'ch1', 'geo', 50)?.templateId, 'slot-spb');
});
