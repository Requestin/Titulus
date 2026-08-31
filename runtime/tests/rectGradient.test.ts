import assert from 'node:assert/strict';
import test from 'node:test';
import {
  effectiveGradient,
  gradientBackgroundCss,
  gradientCacheKey,
  gradientCssCacheSize,
  mixCornerTowardNeutral,
  resetGradientCssCache,
} from '../src/rectGradient.js';
import type { GradientRectLayer } from '../src/schema.js';

function gradientLayer(): GradientRectLayer {
  return {
    id: 'rect',
    name: 'Rect',
    type: 'rect',
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    transform: {
      x: 0, y: 0, width: 100, height: 80,
      rotation: 0, rotationX: 0, rotationY: 0, perspective: 1000,
      scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0,
    },
    groupId: null,
    fill: '#1f2937',
    fillMode: 'gradient',
    cornerRadius: 0,
    borderColor: '#000000',
    borderWidth: 0,
    gradient: {
      topLeft: '#ef4444',
      topRight: '#3b82f6',
      bottomLeft: '#22c55e',
      bottomRight: '#eab308',
      weights: { topLeft: 100, topRight: 80, bottomLeft: 60, bottomRight: 40 },
    },
  };
}

test('mixCornerTowardNeutral keeps full color at 100 and goes to gray at 0', () => {
  assert.equal(mixCornerTowardNeutral('#ef4444', 100), '#ef4444');
  assert.equal(mixCornerTowardNeutral('#ef4444', 0), '#808080');
});

test('effectiveGradient is null for solid rects and copies animated weights', () => {
  const solid = { ...gradientLayer(), fillMode: 'solid' as const, gradient: undefined };
  assert.equal(effectiveGradient(solid), null);

  const layer = gradientLayer();
  const sampled = effectiveGradient(layer, { 'gradient.weights.topLeft': 25 });
  assert.equal(sampled?.weights.topLeft, 25);
  assert.equal(layer.gradient.weights.topLeft, 100);
});

test('gradient cache key is stable for the same effective state', () => {
  const layer = gradientLayer();
  const first = effectiveGradient(layer)!;
  const second = effectiveGradient(layer)!;
  assert.equal(gradientCacheKey(first), gradientCacheKey(second));
  assert.notEqual(
    gradientCacheKey(first),
    gradientCacheKey(effectiveGradient(layer, { 'gradient.weights.topRight': 10 })!),
  );
});

test('gradient css is reused by cache key and not rebuilt on identical state', () => {
  resetGradientCssCache();
  const layer = gradientLayer();
  const paint = effectiveGradient(layer)!;
  const first = gradientBackgroundCss(paint);
  const second = gradientBackgroundCss(paint);
  assert.equal(first, second);
  assert.match(first, /%23ef4444/);
  assert.match(first, /linearGradient/);
  assert.doesNotMatch(first, /width="2" height="2"/);
  assert.equal(gradientCssCacheSize(), 1);
  gradientBackgroundCss(effectiveGradient(layer, { 'gradient.weights.bottomRight': 5 })!);
  assert.equal(gradientCssCacheSize(), 2);
});
