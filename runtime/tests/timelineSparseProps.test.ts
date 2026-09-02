import assert from 'node:assert/strict';
import test from 'node:test';

import { createDefaultTimeline } from '../src/schema.js';
import { normalizeTimeline, sampleAt } from '../src/timeline.js';

test('sparse property tracks interpolate independently and simultaneously', () => {
  const tl = createDefaultTimeline();
  tl.durationFrames = 100;
  tl.directors[0]!.durationFrames = 100;
  tl.trackDirectors = { L1: 'default' };
  // x keyed at 0 / 50 / 100; y only at 0 / 100 — classic dope-sheet sparsity.
  tl.keyframes = [
    { id: 'k0', frame: 0, easing: 'linear', layers: { L1: { x: 0, y: 0 } }, groups: {} },
    { id: 'k1', frame: 50, easing: 'linear', layers: { L1: { x: 50 } }, groups: {} },
    { id: 'k2', frame: 100, easing: 'linear', layers: { L1: { x: 100, y: 100 } }, groups: {} },
  ];

  const n = normalizeTimeline(tl);
  assert.deepEqual(sampleAt(n, 0).layers.L1, { x: 0, y: 0 });
  assert.deepEqual(sampleAt(n, 25).layers.L1, { x: 25, y: 25 });
  assert.deepEqual(sampleAt(n, 50).layers.L1, { x: 50, y: 50 });
  assert.deepEqual(sampleAt(n, 75).layers.L1, { x: 75, y: 75 });
  assert.deepEqual(sampleAt(n, 100).layers.L1, { x: 100, y: 100 });
});

test('property with a single keyframe holds that value', () => {
  const tl = createDefaultTimeline();
  tl.durationFrames = 40;
  tl.directors[0]!.durationFrames = 40;
  tl.trackDirectors = { L1: 'default' };
  tl.keyframes = [
    { id: 'k0', frame: 10, easing: 'linear', layers: { L1: { opacity: 0.5, x: 0 } }, groups: {} },
    { id: 'k1', frame: 30, easing: 'linear', layers: { L1: { x: 100 } }, groups: {} },
  ];

  const n = normalizeTimeline(tl);
  assert.equal(sampleAt(n, 0).layers.L1?.opacity, 0.5);
  assert.equal(sampleAt(n, 20).layers.L1?.opacity, 0.5);
  assert.equal(sampleAt(n, 40).layers.L1?.opacity, 0.5);
  assert.equal(sampleAt(n, 20).layers.L1?.x, 50);
});

test('per-property easing interpolates independently at the same keyframe', () => {
  const tl = createDefaultTimeline();
  tl.durationFrames = 100;
  tl.directors[0]!.durationFrames = 100;
  tl.trackDirectors = { L1: 'default' };
  tl.keyframes = [
    {
      id: 'k0',
      frame: 0,
      easing: 'linear',
      layers: { L1: { x: 0, y: 0 } },
      groups: {},
      layerEasings: { L1: { x: 'linear', y: 'power2.in' } },
    },
    { id: 'k1', frame: 100, easing: 'linear', layers: { L1: { x: 100, y: 100 } }, groups: {} },
  ];
  const n = normalizeTimeline(tl);
  const mid = sampleAt(n, 50).layers.L1;
  assert.equal(mid?.x, 50);
  assert.equal(mid?.y, 25);
});
