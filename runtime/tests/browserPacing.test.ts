import assert from 'node:assert/strict';
import test from 'node:test';

import {
  nextBrowserTickCount,
  type BrowserPacingState,
} from '../src/browserPacing.js';

function state(): BrowserPacingState {
  return { accumulatedMs: 0, lastTickMs: null };
}

function simulateRefresh(refreshHz: number, durationMs: number, timelineFps = 50): number {
  const pacing = state();
  let frames = 0;
  const intervalMs = 1000 / refreshHz;
  for (let timestamp = 0; timestamp <= durationMs + 1e-6; timestamp += intervalMs) {
    frames += nextBrowserTickCount(pacing, timestamp, timelineFps);
  }
  return frames;
}

test('browser pacing is independent of monitor refresh rate', () => {
  for (const refreshHz of [30, 60, 90, 120, 144, 165, 240]) {
    assert.equal(
      simulateRefresh(refreshHz, 10_000),
      500,
      `${refreshHz} Hz must advance a 50 fps timeline by 500 frames`,
    );
  }
});

test('browser pacing preserves fractional time across variable rAF intervals', () => {
  const pacing = state();
  const timestamps = [0, 8, 17, 25, 42, 58, 67, 91, 100];
  let frames = 0;
  for (const timestamp of timestamps) {
    frames += nextBrowserTickCount(pacing, timestamp, 50);
  }

  assert.equal(frames, 5);
  assert.ok(pacing.accumulatedMs < 20);
});

test('browser pacing catches up after a background-tab pause', () => {
  const pacing = state();

  assert.equal(nextBrowserTickCount(pacing, 0, 50), 0);
  assert.equal(nextBrowserTickCount(pacing, 8, 50), 0);
  assert.equal(nextBrowserTickCount(pacing, 1_008, 50), 50);
});

test('browser pacing rejects invalid inputs', () => {
  assert.throws(() => nextBrowserTickCount(state(), Number.NaN, 50), /timestamp/);
  assert.throws(() => nextBrowserTickCount(state(), 1, 0), /fps/);
});
