// runtime/tests/graphProtocol.test.ts
//
// Unit tests for the bounded layer protocol v1 encoder. The engine side mirror
// lives in engine/tests/test_protocol.cpp; the wire format here must round-trip
// with that parser.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  encodeGraphSnapshot,
  PROTOCOL_HEADER,
  PROTOCOL_MAX_LAYERS,
  type ProtocolLayerLayout,
} from '../src/graphProtocol.js';
import type { RenderGraphAnalysis, LayerGraphNode } from '../src/layerPromote.js';

function emptyAnalysis(): RenderGraphAnalysis {
  return {
    analysisVersion: 1,
    supported: true,
    fallbackReasons: [],
    pixelSourceLayerIds: [],
    cacheableSourceLayerIds: [],
    liveSourceLayerIds: [],
    maskOperatorLayerIds: [],
    opportunityScore: 0,
    layers: {},
    groups: {},
    stacks: [],
    maskScopes: [],
    unsupportedLayerIds: [],
    unsupportedGroupIds: [],
  };
}

function cacheableLayer(): LayerGraphNode {
  return {
    nodeKind: 'cached_bitmap',
    cacheableSource: true,
    contentPolicy: 'immutable',
    dirtyDomains: [],
    animatedProps: [],
    animatedGroupIds: [],
    variableIds: [],
    sourceArea: 1920 * 1080,
    operatorSupport: { supported: true, reasons: [] },
  };
}

const identityLayout: ProtocolLayerLayout = {
  x: 0,
  y: 0,
  scale_x: 1,
  scale_y: 1,
  rotation_deg: 0,
  anchor_x: 0,
  anchor_y: 0,
  source_w: 1920,
  source_h: 1080,
  opacity: 1,
  mask_mode: 'none',
};

test('encodes empty snapshot with header and empty layers', () => {
  const out = encodeGraphSnapshot({
    revision: 3,
    analysis: emptyAnalysis(),
    resolveLayout: () => identityLayout,
  });
  assert.equal(out, 'BGGRAPH v1 {"type":"snapshot","rev":3,"layers":[]}');
});

test('encodes one cached bitmap with layout fields', () => {
  const a = emptyAnalysis();
  a.pixelSourceLayerIds = ['layer-a'];
  const node = cacheableLayer();
  node.dirtyDomains = ['props_dirty'];
  a.layers['layer-a'] = node;
  const layout: ProtocolLayerLayout = {
    ...identityLayout,
    x: 100,
    y: 200,
    opacity: 0.5,
  };

  const out = encodeGraphSnapshot({
    revision: 5,
    analysis: a,
    resolveLayout: () => layout,
  });

  assert.ok(out, 'encoder returned null');
  assert.ok(out!.startsWith(PROTOCOL_HEADER + ' '), 'header missing');
  const payload = out!.slice(PROTOCOL_HEADER.length + 1);
  const parsed = JSON.parse(payload);
  assert.equal(parsed.rev, 5);
  assert.equal(parsed.layers.length, 1);
  assert.equal(parsed.layers[0].id, 'layer-a');
  assert.equal(parsed.layers[0].kind, 'cached_bitmap');
  assert.equal(parsed.layers[0].opacity, 0.5);
  assert.equal(parsed.layers[0].x, 100);
  assert.equal(parsed.layers[0].y, 200);
  assert.deepEqual(parsed.layers[0].dirty, ['props_dirty']);
});

test('encodes mask operator with rect array', () => {
  const a = emptyAnalysis();
  a.maskOperatorLayerIds = ['mask-1'];
  const node: LayerGraphNode = {
    ...cacheableLayer(),
    nodeKind: 'mask_operator',
    dirtyDomains: ['mask_dirty'],
  };
  a.layers['mask-1'] = node;
  const layout: ProtocolLayerLayout = {
    ...identityLayout,
    mask_mode: 'inverted',
    mask_rect: { x: 10, y: 20, w: 300, h: 400 },
    source_w: 0,
    source_h: 0,
  };

  const out = encodeGraphSnapshot({
    revision: 1,
    analysis: a,
    resolveLayout: () => layout,
  });

  assert.ok(out, 'encoder returned null');
  const parsed = JSON.parse(out!.slice(PROTOCOL_HEADER.length + 1));
  assert.equal(parsed.layers[0].kind, 'mask_operator');
  assert.equal(parsed.layers[0].mask_mode, 'inverted');
  assert.deepEqual(parsed.layers[0].rect, [10, 20, 300, 400]);
});

test('clamps dirty and unsupported arrays to protocol limits', () => {
  const a = emptyAnalysis();
  a.pixelSourceLayerIds = ['layer-a'];
  const node = cacheableLayer();
  // Five dirty domains -> encoder should clamp to PROTOCOL_MAX_DIRTY_DOMAINS.
  // The analysis type only allows three, but the runtime should still produce
  // a payload that does not exceed the protocol bound.
  node.dirtyDomains = ['content_dirty', 'props_dirty', 'mask_dirty'];
  node.operatorSupport = {
    supported: false,
    reasons: [
      'fractional_rotation',
      'three_d_transform',
      'non_normal_blend',
      'oversized_layer',
      'non_positive_scale',
    ],
  };
  a.layers['layer-a'] = node;

  const out = encodeGraphSnapshot({
    revision: 7,
    analysis: a,
    resolveLayout: () => identityLayout,
  });
  const parsed = JSON.parse(out!.slice(PROTOCOL_HEADER.length + 1));
  assert.ok(parsed.layers[0].dirty.length <= 3);
  assert.ok(parsed.layers[0].unsupported.length <= 8);
});

test('drops snapshot when layer count exceeds bounds', () => {
  const a = emptyAnalysis();
  const ids = Array.from({ length: PROTOCOL_MAX_LAYERS + 1 }, (_, i) => `l${i}`);
  a.pixelSourceLayerIds = ids;
  for (const id of ids) a.layers[id] = cacheableLayer();

  const out = encodeGraphSnapshot({
    revision: 1,
    analysis: a,
    resolveLayout: () => identityLayout,
  });
  assert.equal(out, null);
});

test('drops snapshot when layer extent exceeds bounds', () => {
  const a = emptyAnalysis();
  a.pixelSourceLayerIds = ['x'];
  a.layers['x'] = cacheableLayer();
  const out = encodeGraphSnapshot({
    revision: 1,
    analysis: a,
    resolveLayout: () => ({ ...identityLayout, source_w: 99999 }),
  });
  assert.equal(out, null);
});

test('drops snapshot for negative revision', () => {
  const out = encodeGraphSnapshot({
    revision: -1,
    analysis: emptyAnalysis(),
    resolveLayout: () => identityLayout,
  });
  assert.equal(out, null);
});

test('skips layer when resolver returns null', () => {
  const a = emptyAnalysis();
  a.pixelSourceLayerIds = ['keep', 'drop'];
  a.layers['keep'] = cacheableLayer();
  a.layers['drop'] = cacheableLayer();
  const out = encodeGraphSnapshot({
    revision: 2,
    analysis: a,
    resolveLayout: (id) => (id === 'drop' ? null : identityLayout),
  });
  const parsed = JSON.parse(out!.slice(PROTOCOL_HEADER.length + 1));
  assert.equal(parsed.layers.length, 1);
  assert.equal(parsed.layers[0].id, 'keep');
});

test('escapes id containing quotes and backslashes', () => {
  const a = emptyAnalysis();
  a.pixelSourceLayerIds = ['a"b\\c'];
  a.layers['a"b\\c'] = cacheableLayer();
  const out = encodeGraphSnapshot({
    revision: 4,
    analysis: a,
    resolveLayout: () => identityLayout,
  });
  const parsed = JSON.parse(out!.slice(PROTOCOL_HEADER.length + 1));
  assert.equal(parsed.layers[0].id, 'a"b\\c');
});
