import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeTemplate } from '../analyze_doc02_static_fraction.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const test1 = JSON.parse(fs.readFileSync(path.join(root, 'tests/templates/test1.json'), 'utf8'));
const transform = { x: 0, y: 0, width: 100, height: 100 };

function layer(id, type, overrides = {}) {
  return {
    id,
    type,
    visible: true,
    opacity: 1,
    transform,
    groupId: null,
    ...overrides,
  };
}

function template(overrides = {}) {
  return {
    canvas: { width: 100, height: 100 },
    layers: [
      layer('background', 'image', { src: '/background.png' }),
      layer('bug', 'rect'),
      layer('clock', 'clock'),
    ],
    groups: [],
    rootStack: [
      { kind: 'layer', id: 'background' },
      { kind: 'layer', id: 'bug' },
      { kind: 'layer', id: 'clock' },
    ],
    groupStacks: {},
    variables: [],
    timeline: {
      trackDirectors: { bug: 'main' },
      keyframes: [{ frame: 0, layers: { bug: { x: 0 } }, groups: {} }],
    },
    ...overrides,
  };
}

test('marks asset images without animation as cacheable static layers', () => {
  const report = analyzeTemplate(template());

  assert.deepEqual(report.staticLayerIds, ['background']);
  assert.equal(report.layers.background.reason, 'immutable_image');
});

test('promotes clocks and animated layers to dynamic', () => {
  const report = analyzeTemplate(template());

  assert.deepEqual(report.dynamicLayerIds, ['bug', 'clock']);
  assert.equal(report.layers.bug.reason, 'animated_layer');
  assert.equal(report.layers.clock.reason, 'clock');
});

test('promotes an entire mask scope when its mask is dynamic', () => {
  const masked = template({
    layers: [
      layer('image', 'image', { src: '/image.png' }),
      layer('mask', 'mask'),
    ],
    rootStack: [
      { kind: 'layer', id: 'image' },
      { kind: 'layer', id: 'mask' },
    ],
    timeline: {
      trackDirectors: { mask: 'main' },
      keyframes: [{ frame: 0, layers: { mask: { width: 50 } }, groups: {} }],
    },
  });

  const report = analyzeTemplate(masked);

  assert.deepEqual(report.dynamicLayerIds, ['image', 'mask']);
  assert.equal(report.layers.image.reason, 'dynamic_mask_scope:mask');
});

test('reports the union coverage of cacheable static layer rectangles', () => {
  const scene = template({
    layers: [
      layer('left', 'image', { src: '/left.png', transform: { ...transform, width: 50 } }),
      layer('right', 'image', { src: '/right.png', transform: { ...transform, x: 50, width: 50 } }),
    ],
    rootStack: [
      { kind: 'layer', id: 'left' },
      { kind: 'layer', id: 'right' },
    ],
    timeline: { trackDirectors: {}, keyframes: [] },
  });

  const report = analyzeTemplate(scene);

  assert.equal(report.staticCoverage, 1);
});

test('rejects the doc02 two-plate bet for the canonical test1 mask scope', () => {
  const report = analyzeTemplate(test1);

  assert.equal(report.staticCoverage, 0);
  assert.equal(report.staticLayerIds.length, 0);
  assert.equal(report.dynamicLayerIds.length, test1.layers.length);
});
