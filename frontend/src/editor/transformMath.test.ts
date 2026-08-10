import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultTransform, type Transform } from '@runtime';
import {
  affineFromTransform, ancestorMatrix, canvasDeltaToParent, dragTransform,
  multiplyAffine, reparentTransform, transformPoint,
} from './transformMath';

const start: Transform = {
  ...createDefaultTransform(100, 200),
  width: 50,
  height: 40,
};

test('move and every resize handle alter only their intended unrotated edges', () => {
  const expected = {
    move: { x: 110, y: 205, width: 50, height: 40 },
    n: { x: 100, y: 205, width: 50, height: 35 },
    s: { x: 100, y: 200, width: 50, height: 45 },
    e: { x: 100, y: 200, width: 60, height: 40 },
    w: { x: 110, y: 200, width: 40, height: 40 },
    ne: { x: 100, y: 205, width: 60, height: 35 },
    nw: { x: 110, y: 205, width: 40, height: 35 },
    se: { x: 100, y: 200, width: 60, height: 45 },
    sw: { x: 110, y: 200, width: 40, height: 45 },
  };
  for (const [handle, result] of Object.entries(expected)) {
    assert.deepEqual(dragTransform(handle as keyof typeof expected, start, { x: 10, y: 5 }), result);
  }
});

test('a rotated east resize preserves the opposite top-left geometry', () => {
  const rotated = {
    ...start,
    rotation: 30,
    scaleX: 1.5,
    scaleY: 0.75,
    anchorX: 0.5,
    anchorY: 0.5,
  };
  const before = transformPoint(affineFromTransform(rotated), { x: 0, y: 0 });
  const next = { ...rotated, ...dragTransform('e', rotated, { x: 13, y: 7 }) };
  const after = transformPoint(affineFromTransform(next), { x: 0, y: 0 });
  assert.ok(Math.abs(before.x - after.x) < 1e-8);
  assert.ok(Math.abs(before.y - after.y) < 1e-8);
});

test('pointer deltas are converted through the inverse parent transform', () => {
  const parent = affineFromTransform({
    ...createDefaultTransform(0, 0),
    width: 1,
    height: 1,
    rotation: 90,
    scaleX: 2,
    scaleY: 2,
  });
  const local = canvasDeltaToParent(parent, { x: 0, y: 20 });
  assert.ok(Math.abs(local.x - 10) < 1e-8);
  assert.ok(Math.abs(local.y) < 1e-8);
});

test('reparenting preserves world geometry for a translate/rotate/scale parent', () => {
  const world = {
    ...start,
    rotation: 15,
    scaleX: 1.25,
    scaleY: 0.8,
    anchorX: 0.5,
    anchorY: 0.5,
  };
  const parent = affineFromTransform({
    ...createDefaultTransform(300, 120),
    width: 1,
    height: 1,
    rotation: -20,
    scaleX: 1.5,
    scaleY: 1.5,
  });
  const local = reparentTransform(world, parent);
  const restored = multiplyAffine(parent, affineFromTransform(local));
  const original = affineFromTransform(world);
  for (const key of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
    assert.ok(Math.abs(restored[key] - original[key]) < 1e-8, key);
  }
});

test('ancestor matrices compose nested groups from root to parent', () => {
  const root = {
    id: 'root',
    name: 'Root',
    parentId: null,
    visible: true,
    locked: false,
    transform: { ...createDefaultTransform(10, 0), width: 1, height: 1 },
  };
  const nested = {
    id: 'nested',
    name: 'Nested',
    parentId: 'root',
    visible: true,
    locked: false,
    transform: { ...createDefaultTransform(0, 20), width: 1, height: 1 },
  };
  const matrix = ancestorMatrix(
    { groups: [root, nested] } as Parameters<typeof ancestorMatrix>[0],
    nested.id,
  );
  assert.deepEqual(transformPoint(matrix, { x: 0, y: 0 }), { x: 10, y: 20 });
});
