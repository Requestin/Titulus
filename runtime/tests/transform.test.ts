import assert from 'node:assert/strict';
import test from 'node:test';

import { projectMaskOutline } from '../src/maskGeometry.js';
import { createDefaultTransform } from '../src/schema.js';
import { applyTransform, transformHas3D } from '../src/transform.js';

test('composited z=0 keeps the baseline translate3d literal zero', () => {
  const base = createDefaultTransform(100, 80);
  const missing = applyTransform(base, undefined, { compositePosition: true });
  const zero = applyTransform({ ...base, z: 0 }, undefined, { compositePosition: true });

  assert.equal(missing.transform, zero.transform);
  assert.match(missing.transform, /translate3d\(100\.00px, 80\.00px, 0\)/);
  assert.doesNotMatch(missing.transform, /translate3d\([^)]*0\.00px\)/);
  assert.equal(missing.left, 100);
  assert.equal(missing.top, 80);
  assert.equal(missing.useCompositedPosition, true);
});

test('composited nonzero z writes the depth component in px', () => {
  const base = createDefaultTransform(100, 80);
  const at = applyTransform({ ...base, z: 40 }, undefined, { compositePosition: true });

  assert.match(at.transform, /translate3d\(100\.00px, 80\.00px, 40\.00px\)/);
  assert.equal(at.left, 100);
  assert.equal(at.top, 80);
  assert.equal(at.originX, 0);
  assert.equal(at.originY, 0);
});

test('animated z overrides the base depth without moving the 2D box', () => {
  const base = { ...createDefaultTransform(100, 80), z: 10 };
  const at = applyTransform(base, { z: 25 }, { compositePosition: true });

  assert.match(at.transform, /translate3d\(100\.00px, 80\.00px, 25\.00px\)/);
  assert.equal(at.left, 100);
  assert.equal(at.top, 80);
});

test('nonzero z enables perspective without requiring tilt', () => {
  const base = createDefaultTransform(100, 80);
  const at = applyTransform({ ...base, z: 40 }, undefined, { compositePosition: true });

  assert.match(
    at.transform,
    /^translate3d\(100\.00px, 80\.00px, 40\.00px\) translate\(0\.00px, 0\.00px\) perspective\(1000px\) translate\(0\.00px, 0\.00px\)$/,
  );
});

test('skipPerspective keeps parent-owned perspective and still writes z', () => {
  const at = applyTransform({ ...createDefaultTransform(100, 80), z: 40 }, undefined, {
    compositePosition: true,
    skipPerspective: true,
  });

  assert.doesNotMatch(at.transform, /perspective\(/);
  assert.match(at.transform, /translate3d\(100\.00px, 80\.00px, 40\.00px\)/);
});

test('tilt-only composited path keeps the literal zero depth', () => {
  const base = { ...createDefaultTransform(100, 80), rotationX: 15 };
  const at = applyTransform(base, undefined, { compositePosition: true });

  assert.match(
    at.transform,
    /^translate3d\(100\.00px, 80\.00px, 0\) translate\(0\.00px, 0\.00px\) perspective\(1000px\) rotateX\(15deg\) translate\(0\.00px, 0\.00px\)$/,
  );
});

test('composited rotateX keeps perspective inside the anchor pivot wrap', () => {
  const base = {
    ...createDefaultTransform(100, 80),
    width: 200,
    height: 100,
    anchorX: 0.5,
    anchorY: 0.5,
    rotationX: 30,
  };
  const at = applyTransform(base, undefined, { compositePosition: true });

  assert.equal(at.originX, 100);
  assert.equal(at.originY, 50);
  assert.equal(at.left, 0);
  assert.equal(at.top, 30);
  assert.match(
    at.transform,
    /^translate3d\(0\.00px, 30\.00px, 0\) translate\(100\.00px, 50\.00px\) perspective\(1000px\) rotateX\(30deg\) translate\(-100\.00px, -50\.00px\)$/,
  );
  assert.doesNotMatch(at.transform, /^perspective\(/);
});

test('legacy split ignores z so overlay boxes stay 2D', () => {
  const base = createDefaultTransform(100, 80);
  const flat = applyTransform(base, undefined);
  const deep = applyTransform({ ...base, z: 40 }, undefined);

  assert.equal(flat.transform, deep.transform);
  assert.equal(flat.left, deep.left);
  assert.equal(flat.top, deep.top);
  assert.equal(flat.useCompositedPosition, false);
});

test('transformHas3D is true for nonzero z even when perspective is zero', () => {
  const flat = { ...createDefaultTransform(), perspective: 0 };
  const deep = { ...flat, z: 5 };

  assert.equal(transformHas3D(flat), false);
  assert.equal(transformHas3D(deep), true);
  assert.equal(transformHas3D(createDefaultTransform()), true);
});

test('projected mask outline is unchanged when z is missing or zero', () => {
  const t = { ...createDefaultTransform(40, 40), width: 80, height: 40, rotation: 20 };
  const at = applyTransform(t, undefined);
  const spec = { maskMode: 'normal' as const, shape: 'rect' as const, cornerRadius: 0 };

  assert.deepEqual(
    projectMaskOutline(spec, t, at),
    projectMaskOutline(spec, { ...t, z: 0 }, at),
  );
});

test('projected mask outline applies parent-space z before perspective divide', () => {
  const t0 = { ...createDefaultTransform(40, 40), width: 80, height: 40, rotationX: 30 };
  const t = { ...t0, z: 80 };
  const at = applyTransform(t0, undefined);
  const spec = { maskMode: 'normal' as const, shape: 'rect' as const, cornerRadius: 0 };

  const flat = projectMaskOutline(spec, t0, at);
  const deep = projectMaskOutline(spec, t, at);

  assert.notDeepEqual(flat, deep);
  assert.equal(flat.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), true);
  assert.equal(deep.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), true);
});
