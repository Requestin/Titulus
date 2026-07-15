import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeTemplate } from '../analyze_doc02_static_fraction.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const test1 = JSON.parse(fs.readFileSync(path.join(root, 'tests/templates/test1.json'), 'utf8'));
const transform = {
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  rotation: 0,
  rotationX: 0,
  rotationY: 0,
  perspective: 1000,
  scaleX: 1,
  scaleY: 1,
  anchorX: 0,
  anchorY: 0,
};

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

test('marks immutable pixel sources as cached bitmaps', () => {
  const report = analyzeTemplate(template());

  assert.deepEqual(report.cacheableSourceLayerIds, ['background', 'bug']);
  assert.equal(report.layers.background.nodeKind, 'cached_bitmap');
  assert.equal(report.layers.background.contentPolicy, 'immutable');
  assert.deepEqual(report.layers.background.dirtyDomains, []);
});

test('keeps transform-only animation cacheable and marks props dirty', () => {
  const report = analyzeTemplate(template());

  assert.equal(report.layers.bug.nodeKind, 'cached_bitmap');
  assert.equal(report.layers.bug.cacheableSource, true);
  assert.equal(report.layers.bug.contentPolicy, 'immutable');
  assert.deepEqual(report.layers.bug.dirtyDomains, ['props_dirty']);
  assert.deepEqual(report.layers.bug.animatedProps, ['x']);
});

test('keeps variable-bound text cacheable until an update', () => {
  const variableText = template({
    layers: [
      layer('title', 'text', {
        content: { type: 'variable', variableId: 'headline' },
      }),
    ],
    rootStack: [{ kind: 'layer', id: 'title' }],
    variables: [{ id: 'headline', type: 'text', defaultValue: 'Title' }],
    timeline: { trackDirectors: {}, keyframes: [] },
  });

  const report = analyzeTemplate(variableText);

  assert.equal(report.layers.title.nodeKind, 'cached_bitmap');
  assert.equal(report.layers.title.contentPolicy, 'on_update');
  assert.deepEqual(report.layers.title.dirtyDomains, ['content_dirty']);
  assert.deepEqual(report.layers.title.variableIds, ['headline']);
});

test('represents an animated mask as an operator without invalidating its sources', () => {
  const masked = template({
    layers: [
      layer('image', 'image', { src: '/image.png' }),
      layer('mask', 'mask', { maskMode: 'inverted', shape: 'rect' }),
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

  assert.equal(report.layers.image.nodeKind, 'cached_bitmap');
  assert.equal(report.layers.image.cacheableSource, true);
  assert.deepEqual(report.layers.image.dirtyDomains, []);
  assert.equal(report.layers.mask.nodeKind, 'mask_operator');
  assert.deepEqual(report.layers.mask.dirtyDomains, ['mask_dirty']);
  assert.deepEqual(report.layers.mask.affectedSourceLayerIds, ['image']);
});

test('propagates animated group transforms as props changes, not content changes', () => {
  const grouped = template({
    layers: [
      layer('image', 'image', { src: '/image.png', groupId: 'group' }),
    ],
    groups: [{ id: 'group', transform }],
    rootStack: [{ kind: 'group', id: 'group' }],
    groupStacks: { group: [{ kind: 'layer', id: 'image' }] },
    timeline: {
      trackDirectors: { group: 'main' },
      keyframes: [{ frame: 0, layers: {}, groups: { group: { rotation: 45 } } }],
    },
  });

  const report = analyzeTemplate(grouped);

  assert.equal(report.layers.image.cacheableSource, true);
  assert.deepEqual(report.layers.image.dirtyDomains, ['props_dirty']);
  assert.deepEqual(report.layers.image.animatedGroupIds, ['group']);
  assert.deepEqual(report.groups.group.dirtyDomains, ['props_dirty']);
});

test('keeps clocks live because their source pixels change every frame', () => {
  const report = analyzeTemplate(template());

  assert.equal(report.layers.clock.nodeKind, 'live_html');
  assert.equal(report.layers.clock.cacheableSource, false);
  assert.equal(report.layers.clock.contentPolicy, 'per_frame');
  assert.deepEqual(report.layers.clock.dirtyDomains, ['content_dirty']);
});

test('classifies canonical test1 as cacheable sources plus live clock and mask operators', () => {
  const report = analyzeTemplate(test1);

  assert.equal(report.analysisVersion, 2);
  assert.equal(report.pixelSourceLayerIds.length, 8);
  assert.equal(report.cacheableSourceLayerIds.length, 7);
  assert.deepEqual(report.liveSourceLayerIds, ['5a89287c-9990-42b7-b2d3-4386bb9fc72f']);
  assert.equal(report.maskOperatorLayerIds.length, 2);
  assert.ok(report.opportunityScore > 0.9);
  assert.equal(report.legacyTwoPlateStaticCoverage, 0);

  const rootMask = report.layers['4f4d7b40-7556-4de2-9795-a16d0e848dd9'];
  assert.equal(rootMask.nodeKind, 'mask_operator');
  assert.deepEqual(rootMask.dirtyDomains, ['mask_dirty']);
  assert.equal(rootMask.affectedSourceLayerIds.length, 8);
});
