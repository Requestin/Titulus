import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultTransform } from '@runtime';
import {
  axisPresetX,
  axisPresetY,
  canvasFitSize,
  has25dCost,
  lockedScale,
} from './axisPresets';

test('horizontal axis presets compensate x so the unrotated box stays put', () => {
  const t = { ...createDefaultTransform(200, 100), width: 200, height: 80, anchorX: 0, anchorY: 0 };

  assert.deepEqual(axisPresetX(t, 0.5), { anchorX: 0.5, x: 300, y: 100 });
  assert.deepEqual(axisPresetX(t, 1), { anchorX: 1, x: 400, y: 100 });
  assert.deepEqual(axisPresetX(t, 0), { anchorX: 0, x: 200, y: 100 });
});

test('vertical axis presets compensate y so the unrotated box stays put', () => {
  const t = { ...createDefaultTransform(200, 100), width: 200, height: 80, anchorX: 0, anchorY: 0 };

  assert.deepEqual(axisPresetY(t, 0.5), { anchorY: 0.5, x: 200, y: 140 });
  assert.deepEqual(axisPresetY(t, 1), { anchorY: 1, x: 200, y: 180 });
  assert.deepEqual(axisPresetY(t, 0), { anchorY: 0, x: 200, y: 100 });
});

test('canvas fit sizes use the template canvas and keep the opposite ratio for width/height', () => {
  const canvas = { width: 1920, height: 1080 };
  const current = { width: 300, height: 80 };

  assert.deepEqual(canvasFitSize(canvas, 'screen', current), { width: 1920, height: 1080 });
  assert.deepEqual(canvasFitSize(canvas, 'width', current), { width: 1920, height: 512 });
  assert.deepEqual(canvasFitSize(canvas, 'height', current), { width: 4050, height: 1080 });
});

test('locked scale multiplies the opposite axis by the same ratio', () => {
  const current = { scaleX: 2, scaleY: 0.5 };

  assert.deepEqual(lockedScale(current, { scaleX: 4 }), { scaleX: 4, scaleY: 1 });
  assert.deepEqual(lockedScale(current, { scaleY: 1 }), { scaleX: 4, scaleY: 1 });
});

test('locked scale stays finite when the current axis is zero', () => {
  assert.deepEqual(lockedScale({ scaleX: 0, scaleY: 2 }, { scaleX: 1.5 }), { scaleX: 1.5, scaleY: 2 });
});

test('2.5D cost warning is true for tilt or nonzero z only', () => {
  const base = createDefaultTransform();
  assert.equal(has25dCost(base), false);
  assert.equal(has25dCost({ ...base, z: 0 }), false);
  assert.equal(has25dCost({ ...base, z: 12 }), true);
  assert.equal(has25dCost({ ...base, rotationX: 5 }), true);
  assert.equal(has25dCost({ ...base, rotationY: -8 }), true);
});
