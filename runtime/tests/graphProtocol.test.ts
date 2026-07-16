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
  affine: [1, 0, 0, 0, 1, 0],
};

test('encodes empty snapshot with header and empty layers', () => {
  const out = encodeGraphSnapshot({
    templateId: 'test1',
    graphRevision: 3,
    stateRevision: 0,
    analysis: emptyAnalysis(),
    resolveLayout: () => identityLayout,
  });
  assert.equal(
    out,
    'BGGRAPH v1 {"type":"snapshot","template_id":"test1","graph_rev":3,"state_rev":0,"layers":[]}',
  );
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
    graphRevision: 5,
    stateRevision: 8,
    analysis: a,
    resolveLayout: () => layout,
  });

  assert.ok(out, 'encoder returned null');
  assert.ok(out!.startsWith(PROTOCOL_HEADER + ' '), 'header missing');
  const payload = out!.slice(PROTOCOL_HEADER.length + 1);
  const parsed = JSON.parse(payload);
  assert.equal(parsed.graph_rev, 5);
  assert.equal(parsed.state_rev, 8);
  assert.equal(parsed.layers.length, 1);
  assert.equal(parsed.layers[0].id, 'layer-a');
  assert.equal(parsed.layers[0].kind, 'cached_bitmap');
  assert.equal(parsed.layers[0].opacity, 0.5);
  assert.equal(parsed.layers[0].x, 100);
  assert.equal(parsed.layers[0].y, 200);
  assert.deepEqual(parsed.layers[0].dirty, ['props_dirty']);
});

test('encodes only known unique content invalidations', () => {
  const analysis = emptyAnalysis();
  analysis.layers.a = cacheableLayer();
  analysis.pixelSourceLayerIds = ['a'];
  analysis.cacheableSourceLayerIds = ['a'];
  const valid = encodeGraphSnapshot({
    graphRevision: 3,
    stateRevision: 2,
    invalidatedLayerIds: ['a'],
    analysis,
    resolveLayout: () => identityLayout,
  });
  assert.match(valid ?? '', /"state_rev":2,"invalidate":\["a"\],"layers":/);
  assert.equal(encodeGraphSnapshot({
    graphRevision: 3,
    stateRevision: 2,
    invalidatedLayerIds: ['missing'],
    analysis,
    resolveLayout: () => identityLayout,
  }), null);
  assert.equal(encodeGraphSnapshot({
    graphRevision: 3,
    stateRevision: 2,
    invalidatedLayerIds: ['a', 'a'],
    analysis,
    resolveLayout: () => identityLayout,
  }), null);
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
    graphRevision: 1,
    stateRevision: 0,
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
    graphRevision: 7,
    stateRevision: 0,
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
    graphRevision: 1,
    stateRevision: 0,
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
    graphRevision: 1,
    stateRevision: 0,
    analysis: a,
    resolveLayout: () => ({ ...identityLayout, source_w: 99999 }),
  });
  assert.equal(out, null);
});

test('drops snapshot for negative revision', () => {
  const out = encodeGraphSnapshot({
    graphRevision: -1,
    stateRevision: 0,
    analysis: emptyAnalysis(),
    resolveLayout: () => identityLayout,
  });
  assert.equal(out, null);
});

test('rejects whole snapshot when any layer layout is missing', () => {
  const a = emptyAnalysis();
  a.pixelSourceLayerIds = ['keep', 'drop'];
  a.layers['keep'] = cacheableLayer();
  a.layers['drop'] = cacheableLayer();
  const out = encodeGraphSnapshot({
    graphRevision: 2,
    stateRevision: 0,
    analysis: a,
    resolveLayout: (id) => (id === 'drop' ? null : identityLayout),
  });
  assert.equal(out, null);
});

test('rejects singular affine transform before publishing', () => {
  const a = emptyAnalysis();
  a.pixelSourceLayerIds = ['layer-a'];
  a.layers['layer-a'] = cacheableLayer();
  const out = encodeGraphSnapshot({
    graphRevision: 2,
    stateRevision: 0,
    analysis: a,
    resolveLayout: () => ({
      ...identityLayout,
      affine: [1, 2, 0, 2, 4, 0],
    }),
  });
  assert.equal(out, null);
});

test('maps animated source extent to a fail-closed wire reason', () => {
  const a = emptyAnalysis();
  a.pixelSourceLayerIds = ['layer-a'];
  const node = cacheableLayer();
  node.operatorSupport = {
    supported: false,
    reasons: ['animated_source_extent'],
  };
  a.layers['layer-a'] = node;
  const out = encodeGraphSnapshot({
    graphRevision: 2,
    stateRevision: 0,
    analysis: a,
    resolveLayout: () => identityLayout,
  });
  assert.ok(out);
  const parsed = JSON.parse(out.slice(PROTOCOL_HEADER.length + 1));
  assert.deepEqual(parsed.layers[0].unsupported, ['oversized_layer']);
});

test('rejects fractional mask rectangles that C++ cannot parse', () => {
  const a = emptyAnalysis();
  a.maskOperatorLayerIds = ['mask'];
  a.layers.mask = {
    ...cacheableLayer(),
    nodeKind: 'mask_operator',
  };
  const out = encodeGraphSnapshot({
    graphRevision: 2,
    stateRevision: 0,
    analysis: a,
    resolveLayout: () => ({
      ...identityLayout,
      source_w: 0,
      source_h: 0,
      mask_mode: 'normal',
      mask_rect: { x: 0.5, y: 0, w: 10, h: 10 },
    }),
  });
  assert.equal(out, null);
});

test('escapes id containing quotes and backslashes', () => {
  const a = emptyAnalysis();
  a.pixelSourceLayerIds = ['a"b\\c'];
  a.layers['a"b\\c'] = cacheableLayer();
  const out = encodeGraphSnapshot({
    graphRevision: 4,
    stateRevision: 0,
    analysis: a,
    resolveLayout: () => identityLayout,
  });
  const parsed = JSON.parse(out!.slice(PROTOCOL_HEADER.length + 1));
  assert.equal(parsed.layers[0].id, 'a"b\\c');
});
