import assert from 'node:assert/strict';
import test from 'node:test';

import {
  nextFixedTickCount,
  type FixedPacingState,
} from '../src/fixedPacing.js';

function state(): FixedPacingState {
  return { accumulatedMs: 0, lastTickMs: null };
}

test('accumulator preserves wall-time catch-up and caps backlog', () => {
  const pacing = state();

  assert.equal(nextFixedTickCount(pacing, 100, 50, 'accumulator'), 0);
  assert.equal(nextFixedTickCount(pacing, 140, 50, 'accumulator'), 2);
  assert.equal(nextFixedTickCount(pacing, 140.1, 50, 'accumulator'), 0);
  assert.equal(nextFixedTickCount(pacing, 1_000, 50, 'accumulator'), 4);
});

test('one-tick mode advances exactly once per BeginFrame without inherited debt', () => {
  const pacing = { accumulatedMs: 60, lastTickMs: 100 };

  assert.equal(nextFixedTickCount(pacing, 140, 50, 'one_tick'), 1);
  assert.deepEqual(pacing, { accumulatedMs: 0, lastTickMs: 140 });
  assert.equal(nextFixedTickCount(pacing, 145, 50, 'one_tick'), 1);
  assert.equal(nextFixedTickCount(pacing, 160, 50, 'one_tick'), 1);
});

test('rejects invalid fixed pacing inputs', () => {
  assert.throws(() => nextFixedTickCount(state(), Number.NaN, 50, 'accumulator'), /timestamp/);
  assert.throws(() => nextFixedTickCount(state(), 1, 0, 'accumulator'), /fps/);
});
