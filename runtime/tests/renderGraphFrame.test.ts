import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { encodeGraphSnapshot, PROTOCOL_HEADER } from '../src/graphProtocol.js';
import { classifyRenderGraph } from '../src/layerPromote.js';
import { buildProtocolFrameLayouts } from '../src/renderGraphFrame.js';
import type { Template } from '../src/schema.js';
import { normalizeTimeline, sampleAt } from '../src/timeline.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const test1 = JSON.parse(
  fs.readFileSync(path.join(root, 'tests/templates/test1.json'), 'utf8'),
) as Template;

test('flattens animated layer and group transforms into affine matrices', () => {
  const analysis = classifyRenderGraph(test1);
  const timeline = normalizeTimeline(test1.timeline);
  const frame0 = buildProtocolFrameLayouts(
    test1,
    analysis,
    sampleAt(timeline, 0),
  );
  const frame100 = buildProtocolFrameLayouts(
    test1,
    analysis,
    sampleAt(timeline, 100),
  );

  const clockId = '5a89287c-9990-42b7-b2d3-4386bb9fc72f';
  assert.ok(Math.abs(frame0[clockId].affine[2] - 0) < 0.01);
  assert.ok(Math.abs(frame100[clockId].affine[2] - 1600) < 0.01);

  const groupChildId = '378974ae-83fd-437c-8f53-009fce8d0c30';
  assert.ok(Math.abs(frame100[groupChildId].affine[0]) < 0.001);
  assert.ok(Math.abs(frame100[groupChildId].affine[3] - 1) < 0.001);
  assert.ok(frame100[groupChildId].affine[2] > 1000);
});

test('encodes stack order, state revision, affine and explicit mask scopes', () => {
  const analysis = classifyRenderGraph(test1);
  const timeline = normalizeTimeline(test1.timeline);
  const layouts = buildProtocolFrameLayouts(
    test1,
    analysis,
    sampleAt(timeline, 50),
  );
  const encoded = encodeGraphSnapshot({
    graphRevision: 11,
    stateRevision: 50,
    analysis,
    resolveLayout: (id) => layouts[id] ?? null,
  });
  assert.ok(encoded);
  const payload = JSON.parse(encoded.slice(PROTOCOL_HEADER.length + 1));
  assert.equal(payload.graph_rev, 11);
  assert.equal(payload.state_rev, 50);

  const ids = payload.layers.map((layer: { id: string }) => layer.id);
  assert.deepEqual(ids.slice(0, 4), [
    '378974ae-83fd-437c-8f53-009fce8d0c30',
    '1230dd26-af3f-4a3f-bf71-ffaa0bd94e97',
    'ba5107c9-eff5-4a5a-8062-83a39a934946',
    '210ee6a3-4e2d-4f86-8869-77706962c172',
  ]);

  const mask = payload.layers.find(
    (layer: { id: string }) =>
      layer.id === '210ee6a3-4e2d-4f86-8869-77706962c172',
  );
  assert.ok(mask);
  assert.deepEqual(mask.affects, [
    'ba5107c9-eff5-4a5a-8062-83a39a934946',
  ]);
  assert.equal(mask.m.length, 6);
});

test('projects hidden layers and hidden group descendants as transparent', () => {
  const template = structuredClone(test1);
  const hiddenLayer = template.layers.find(
    (layer) => layer.id === '30caeeb9-86ca-4c53-9078-3162c2deaf90',
  );
  const hiddenGroup = template.groups.find(
    (group) => group.id === '66bbe0fd-94f5-42c0-b8d8-8d9b2c25731d',
  );
  assert.ok(hiddenLayer);
  assert.ok(hiddenGroup);
  hiddenLayer.visible = false;
  hiddenGroup.visible = false;

  const analysis = classifyRenderGraph(template);
  const layouts = buildProtocolFrameLayouts(
    template,
    analysis,
    sampleAt(normalizeTimeline(template.timeline), 0),
  );

  assert.equal(layouts[hiddenLayer.id].opacity, 0);
  assert.equal(layouts['378974ae-83fd-437c-8f53-009fce8d0c30'].opacity, 0);
  assert.equal(layouts['1230dd26-af3f-4a3f-bf71-ffaa0bd94e97'].opacity, 0);
});
