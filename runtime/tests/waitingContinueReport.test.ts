import assert from 'node:assert/strict';
import test from 'node:test';

import { diffWaitingContinue } from '../src/waitingContinueReport.js';

test('diffWaitingContinue reports only transitions', () => {
  const first = diffWaitingContinue(new Map(), [['tpl', true]]);
  assert.deepEqual(first.changed, [{ templateId: 'tpl', waiting: true }]);
  const second = diffWaitingContinue(first.snapshot, [['tpl', true]]);
  assert.deepEqual(second.changed, []);
  const third = diffWaitingContinue(second.snapshot, [['tpl', false]]);
  assert.deepEqual(third.changed, [{ templateId: 'tpl', waiting: false }]);
});
