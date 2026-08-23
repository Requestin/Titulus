import assert from 'node:assert/strict';
import test from 'node:test';

import { compareAirRoots, resolveLayerId } from '../src/airStack.js';

test('compareAirRoots sorts by layerId then takeSeq then slotId', () => {
  const items = [
    { layerId: 90, takeSeq: 1, slotId: 'front-early' },
    { layerId: 10, takeSeq: 3, slotId: 'back' },
    { layerId: 90, takeSeq: 2, slotId: 'front-late' },
    { layerId: 90, takeSeq: 2, slotId: 'front-late-b' },
  ];
  assert.deepEqual(
    [...items].sort(compareAirRoots).map((item) => item.slotId),
    ['back', 'front-early', 'front-late', 'front-late-b'],
  );
});

test('resolveLayerId defaults to 50 and clamps 1-99', () => {
  assert.equal(resolveLayerId(undefined), 50);
  assert.equal(resolveLayerId(4.2), 50);
  assert.equal(resolveLayerId(0), 1);
  assert.equal(resolveLayerId(100), 99);
  assert.equal(resolveLayerId(42), 42);
});
