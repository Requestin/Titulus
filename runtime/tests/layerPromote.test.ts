import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { classifyRenderGraph } from '../src/layerPromote.js';
import type { Layer, Template, Transform } from '../src/schema.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const test1 = JSON.parse(
  fs.readFileSync(path.join(root, 'tests/templates/test1.json'), 'utf8'),
) as Template;

const transform: Transform = {
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

function layer(id: string, type: Layer['type'], overrides: Record<string, unknown> = {}): Layer {
  return {
    id,
    name: id,
    type,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    transform,
    groupId: null,
    ...overrides,
  } as Layer;
}

function template(overrides: Partial<Template> = {}): Template {
  return {
    id: 'fixture',
    name: 'fixture',
    canvas: { width: 100, height: 100, background: 'transparent' },
    layers: [
      layer('background', 'image', { src: '/background.png', cornerRadius: 0, fit: 'cover' }),
      layer('bug', 'rect', { fill: '#fff', cornerRadius: 0, borderColor: '#000', borderWidth: 0 }),
      layer('clock', 'clock', {
        mode: 'clock',
        format: 'HH:mm:ss',
        style: {},
      }),
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
      fps: 50,
      durationFrames: 100,
      playbackMode: 'bounded',
      directors: [{
        id: 'main',
        name: 'main',
        durationFrames: 100,
        offsetFrames: 0,
        autostart: true,
        loop: true,
        swing: false,
      }],
      trackDirectors: { bug: 'main' },
      keyframes: [{
        id: 'kf0',
        frame: 0,
        layers: { bug: { x: 0 } },
        groups: {},
        easing: 'linear',
      }],
      actions: [],
    },
    ...overrides,
  };
}

test('keeps transform-only animation as a cached bitmap', () => {
  const report = classifyRenderGraph(template());

  assert.equal(report.layers.bug.nodeKind, 'cached_bitmap');
  assert.equal(report.layers.bug.contentPolicy, 'immutable');
  assert.deepEqual(report.layers.bug.dirtyDomains, ['props_dirty']);
  assert.deepEqual(report.layers.bug.animatedProps, ['x']);
});

test('keeps unknown content-changing animation on the live HTML path', () => {
  const scene = template();
  scene.timeline.keyframes[0].layers.bug = { fill: '#000' } as never;

  const report = classifyRenderGraph(scene);

  assert.equal(report.layers.bug.nodeKind, 'live_html');
  assert.equal(report.layers.bug.contentPolicy, 'per_frame');
  assert.deepEqual(report.layers.bug.dirtyDomains, ['content_dirty']);
});

test('recaptures variable-bound text only when its variable updates', () => {
  const scene = template({
    layers: [layer('title', 'text', {
      content: { type: 'variable', variableId: 'headline' },
      style: {},
    })],
    rootStack: [{ kind: 'layer', id: 'title' }],
    variables: [{
      id: 'headline',
      name: 'headline',
      label: 'Headline',
      type: 'text',
      defaultValue: 'Title',
    }],
    timeline: {
      ...template().timeline,
      trackDirectors: {},
      keyframes: [],
    },
  });

  const report = classifyRenderGraph(scene);

  assert.equal(report.layers.title.nodeKind, 'cached_bitmap');
  assert.equal(report.layers.title.contentPolicy, 'on_update');
  assert.deepEqual(report.layers.title.dirtyDomains, ['content_dirty']);
  assert.deepEqual(report.layers.title.variableIds, ['headline']);
});

test('turns an animated mask into an operator without invalidating source pixels', () => {
  const scene = template({
    layers: [
      layer('image', 'image', { src: '/image.png', cornerRadius: 0, fit: 'contain' }),
      layer('mask', 'mask', {
        maskMode: 'inverted',
        shape: 'rect',
        fill: '#000',
        cornerRadius: 0,
        borderColor: '#000',
        borderWidth: 0,
      }),
    ],
    rootStack: [
      { kind: 'layer', id: 'image' },
      { kind: 'layer', id: 'mask' },
    ],
    timeline: {
      ...template().timeline,
      trackDirectors: { mask: 'main' },
      keyframes: [{
        id: 'kf0',
        frame: 0,
        layers: { mask: { width: 50 } },
        groups: {},
        easing: 'linear',
      }],
    },
  });

  const report = classifyRenderGraph(scene);

  assert.equal(report.layers.image.nodeKind, 'cached_bitmap');
  assert.deepEqual(report.layers.image.dirtyDomains, []);
  assert.equal(report.layers.mask.nodeKind, 'mask_operator');
  assert.deepEqual(report.layers.mask.dirtyDomains, ['mask_dirty']);
  assert.deepEqual(report.layers.mask.affectedSourceLayerIds, ['image']);
});

test('propagates animated group transforms as props changes', () => {
  const scene = template({
    layers: [layer('image', 'image', {
      src: '/image.png',
      cornerRadius: 0,
      fit: 'contain',
      groupId: 'group',
    })],
    groups: [{
      id: 'group',
      name: 'group',
      parentId: null,
      visible: true,
      locked: false,
      transform,
    }],
    rootStack: [{ kind: 'group', id: 'group' }],
    groupStacks: { group: [{ kind: 'layer', id: 'image' }] },
    timeline: {
      ...template().timeline,
      trackDirectors: { group: 'main' },
      keyframes: [{
        id: 'kf0',
        frame: 0,
        layers: {},
        groups: { group: { rotation: 45 } },
        easing: 'linear',
      }],
    },
  });

  const report = classifyRenderGraph(scene);

  assert.equal(report.layers.image.cacheableSource, true);
  assert.deepEqual(report.layers.image.animatedGroupIds, ['group']);
  assert.deepEqual(report.layers.image.dirtyDomains, ['props_dirty']);
  assert.deepEqual(report.groups.group.dirtyDomains, ['props_dirty']);
});

test('rejects non-positive animated group scale before live projection', () => {
  const scene = template({
    layers: [layer('image', 'image', {
      src: '/image.png',
      cornerRadius: 0,
      fit: 'contain',
      groupId: 'group',
    })],
    groups: [{
      id: 'group',
      name: 'group',
      parentId: null,
      visible: true,
      locked: false,
      transform,
    }],
    rootStack: [{ kind: 'group', id: 'group' }],
    groupStacks: { group: [{ kind: 'layer', id: 'image' }] },
    timeline: {
      ...template().timeline,
      trackDirectors: { group: 'main' },
      keyframes: [{
        id: 'kf0',
        frame: 0,
        layers: {},
        groups: { group: { scaleX: 0 } },
        easing: 'linear',
      }],
    },
  });

  const report = classifyRenderGraph(scene);
  assert.equal(report.supported, false);
  assert.deepEqual(report.groups.group.operatorSupport.reasons, ['non_positive_scale']);
});

test('marks unsupported 3D sources for whole-template fallback', () => {
  const scene = template({
    layers: [layer('image', 'image', {
      src: '/image.png',
      cornerRadius: 0,
      fit: 'contain',
      transform: { ...transform, rotationY: 30 },
    })],
    rootStack: [{ kind: 'layer', id: 'image' }],
    timeline: {
      ...template().timeline,
      trackDirectors: {},
      keyframes: [],
    },
  });

  const report = classifyRenderGraph(scene);

  assert.deepEqual(report.unsupportedLayerIds, ['image']);
  assert.equal(report.layers.image.operatorSupport.supported, false);
  assert.deepEqual(report.layers.image.operatorSupport.reasons, ['3d_transform']);
});

test('keeps clocks live because their source pixels change every frame', () => {
  const report = classifyRenderGraph(template());

  assert.equal(report.layers.clock.nodeKind, 'live_html');
  assert.equal(report.layers.clock.cacheableSource, false);
  assert.equal(report.layers.clock.contentPolicy, 'per_frame');
  assert.deepEqual(report.layers.clock.dirtyDomains, ['content_dirty']);
});

test('builds the canonical test1 operator graph without unsupported nodes', () => {
  const report = classifyRenderGraph(test1);

  assert.equal(report.analysisVersion, 1);
  assert.equal(report.pixelSourceLayerIds.length, 8);
  assert.equal(report.cacheableSourceLayerIds.length, 7);
  assert.deepEqual(report.liveSourceLayerIds, ['5a89287c-9990-42b7-b2d3-4386bb9fc72f']);
  assert.equal(report.maskOperatorLayerIds.length, 2);
  assert.ok(report.opportunityScore > 0.9);
  assert.deepEqual(report.unsupportedLayerIds, []);

  const rootMask = report.layers['4f4d7b40-7556-4de2-9795-a16d0e848dd9'];
  assert.deepEqual(rootMask.dirtyDomains, ['mask_dirty']);
  assert.equal(rootMask.affectedSourceLayerIds?.length, 8);
});

test('fails closed for a nonzero layer z transform', () => {
  const scene = template({
    layers: [layer('image', 'image', {
      src: '/image.png',
      cornerRadius: 0,
      fit: 'contain',
      transform: { ...transform, z: 10 },
    })],
    rootStack: [{ kind: 'layer', id: 'image' }],
    timeline: {
      ...template().timeline,
      trackDirectors: {},
      keyframes: [],
    },
  });

  const report = classifyRenderGraph(scene);

  assert.equal(report.supported, false);
  assert.deepEqual(report.fallbackReasons, ['layer:image:z_transform']);
  assert.deepEqual(report.unsupportedLayerIds, ['image']);
  assert.deepEqual(report.liveSourceLayerIds, ['image']);
  assert.equal(report.layers.image.nodeKind, 'live_html');
  assert.equal(report.layers.image.cacheableSource, false);
  assert.deepEqual(report.layers.image.operatorSupport.reasons, ['z_transform']);
});

test('fails closed for an animated layer z transform', () => {
  const scene = template({
    layers: [layer('image', 'image', {
      src: '/image.png',
      cornerRadius: 0,
      fit: 'contain',
    })],
    rootStack: [{ kind: 'layer', id: 'image' }],
    timeline: {
      ...template().timeline,
      trackDirectors: { image: 'main' },
      keyframes: [{
        id: 'kf0',
        frame: 0,
        layers: { image: { z: 10 } },
        groups: {},
        easing: 'linear',
      }],
    },
  });

  const report = classifyRenderGraph(scene);

  assert.equal(report.supported, false);
  assert.deepEqual(report.fallbackReasons, ['layer:image:z_transform']);
  assert.deepEqual(report.liveSourceLayerIds, ['image']);
  assert.deepEqual(report.layers.image.animatedProps, ['z']);
  assert.equal(report.layers.image.nodeKind, 'live_html');
  assert.deepEqual(report.layers.image.operatorSupport.reasons, ['z_transform']);
});

test('fails closed for a crawl layer', () => {
  const scene = template({
    layers: [layer('crawl', 'crawl', {
      content: 'Breaking news',
      style: {},
      crawlDirectorId: 'main',
      crawl: {
        type: 'ticker',
        directionIn: 'left',
        directionOut: 'left',
        speed: 100,
        pause: 0,
        separatorMode: 'text',
        separatorText: ' • ',
        separatorImage: '',
        animationType: 'continuous',
        useFile: false,
        filePath: '',
        maxTextLengthEnabled: false,
        maxTextLength: 0,
      },
    })],
    rootStack: [{ kind: 'layer', id: 'crawl' }],
    timeline: {
      ...template().timeline,
      trackDirectors: {},
      keyframes: [],
    },
  });

  const report = classifyRenderGraph(scene);

  assert.equal(report.supported, false);
  assert.deepEqual(report.fallbackReasons, ['layer:crawl:crawl_layer']);
  assert.deepEqual(report.unsupportedLayerIds, ['crawl']);
  assert.deepEqual(report.liveSourceLayerIds, ['crawl']);
  assert.equal(report.layers.crawl.nodeKind, 'live_html');
  assert.equal(report.layers.crawl.cacheableSource, false);
  assert.deepEqual(report.layers.crawl.operatorSupport.reasons, ['crawl_layer']);
});

test('fails closed for a static rectangle gradient', () => {
  const scene = template({
    layers: [layer('gradient', 'rect', {
      fill: '#000',
      fillMode: 'gradient',
      gradient: {
        topLeft: '#f00',
        topRight: '#0f0',
        bottomLeft: '#00f',
        bottomRight: '#fff',
        weights: { topLeft: 25, topRight: 25, bottomLeft: 25, bottomRight: 25 },
      },
      cornerRadius: 0,
      borderColor: '#000',
      borderWidth: 0,
    })],
    rootStack: [{ kind: 'layer', id: 'gradient' }],
    timeline: {
      ...template().timeline,
      trackDirectors: {},
      keyframes: [],
    },
  });

  const report = classifyRenderGraph(scene);

  assert.equal(report.supported, false);
  assert.deepEqual(report.fallbackReasons, ['layer:gradient:gradient_fill']);
  assert.deepEqual(report.unsupportedLayerIds, ['gradient']);
  assert.deepEqual(report.liveSourceLayerIds, ['gradient']);
  assert.equal(report.layers.gradient.nodeKind, 'live_html');
  assert.equal(report.layers.gradient.cacheableSource, false);
  assert.deepEqual(report.layers.gradient.operatorSupport.reasons, ['gradient_fill']);
});

test('fails closed for animated rectangle gradient weights', () => {
  const scene = template({
    layers: [layer('gradient', 'rect', {
      fill: '#000',
      fillMode: 'gradient',
      gradient: {
        topLeft: '#f00',
        topRight: '#0f0',
        bottomLeft: '#00f',
        bottomRight: '#fff',
        weights: { topLeft: 25, topRight: 25, bottomLeft: 25, bottomRight: 25 },
      },
      cornerRadius: 0,
      borderColor: '#000',
      borderWidth: 0,
    })],
    rootStack: [{ kind: 'layer', id: 'gradient' }],
    timeline: {
      ...template().timeline,
      trackDirectors: { gradient: 'main' },
      keyframes: [{
        id: 'kf0',
        frame: 0,
        layers: { gradient: { 'gradient.weights.topLeft': 75 } },
        groups: {},
        easing: 'linear',
      }],
    },
  });

  const report = classifyRenderGraph(scene);

  assert.equal(report.supported, false);
  assert.deepEqual(report.fallbackReasons, ['layer:gradient:gradient_fill']);
  assert.deepEqual(report.liveSourceLayerIds, ['gradient']);
  assert.deepEqual(report.layers.gradient.animatedProps, ['gradient.weights.topLeft']);
  assert.equal(report.layers.gradient.nodeKind, 'live_html');
  assert.deepEqual(report.layers.gradient.operatorSupport.reasons, ['gradient_fill']);
});

test('fails closed for a nonzero group z transform', () => {
  const scene = template({
    layers: [layer('image', 'image', {
      src: '/image.png',
      cornerRadius: 0,
      fit: 'contain',
      groupId: 'group',
    })],
    groups: [{
      id: 'group',
      name: 'group',
      parentId: null,
      visible: true,
      locked: false,
      transform: { ...transform, z: 10 },
    }],
    rootStack: [{ kind: 'group', id: 'group' }],
    groupStacks: { group: [{ kind: 'layer', id: 'image' }] },
    timeline: {
      ...template().timeline,
      trackDirectors: {},
      keyframes: [],
    },
  });

  const report = classifyRenderGraph(scene);

  assert.equal(report.supported, false);
  assert.deepEqual(report.fallbackReasons, ['group:group:z_transform']);
  assert.deepEqual(report.unsupportedGroupIds, ['group']);
  assert.equal(report.groups.group.operatorSupport.supported, false);
  assert.deepEqual(report.groups.group.operatorSupport.reasons, ['z_transform']);
});

test('fails closed for an animated group z transform', () => {
  const scene = template({
    layers: [layer('image', 'image', {
      src: '/image.png',
      cornerRadius: 0,
      fit: 'contain',
      groupId: 'group',
    })],
    groups: [{
      id: 'group',
      name: 'group',
      parentId: null,
      visible: true,
      locked: false,
      transform,
    }],
    rootStack: [{ kind: 'group', id: 'group' }],
    groupStacks: { group: [{ kind: 'layer', id: 'image' }] },
    timeline: {
      ...template().timeline,
      trackDirectors: { group: 'main' },
      keyframes: [{
        id: 'kf0',
        frame: 0,
        layers: {},
        groups: { group: { z: 10 } },
        easing: 'linear',
      }],
    },
  });

  const report = classifyRenderGraph(scene);

  assert.equal(report.supported, false);
  assert.deepEqual(report.fallbackReasons, ['group:group:z_transform']);
  assert.deepEqual(report.unsupportedGroupIds, ['group']);
  assert.deepEqual(report.groups.group.animatedProps, ['z']);
  assert.equal(report.groups.group.operatorSupport.supported, false);
  assert.deepEqual(report.groups.group.operatorSupport.reasons, ['z_transform']);
});
