import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Template } from '../src/schema.js';
import { normalizeTimeline, sampleAt } from '../src/timeline.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const test1 = JSON.parse(
  fs.readFileSync(path.join(root, 'tests/templates/test1.json'), 'utf8'),
) as Template;

test('canonical test1 samples stay identical when propertyTrackDirectors is absent', () => {
  const classic = sampleAt(normalizeTimeline(test1.timeline), 50);
  const withEmpty = structuredClone(test1);
  delete withEmpty.timeline.propertyTrackDirectors;
  const again = sampleAt(normalizeTimeline(withEmpty.timeline), 50);
  assert.deepEqual(again.layers, classic.layers);
  assert.deepEqual(again.groups, classic.groups);
});

test('propertyTrackDirectors split a shared-frame bag across directors', () => {
  const template = structuredClone(test1);
  const layerId = template.layers[0]!.id;
  template.timeline.directors.push({
    id: 'extra',
    name: 'extra',
    durationFrames: template.timeline.durationFrames,
    offsetFrames: 0,
    autostart: true,
    loop: false,
    swing: false,
  });
  template.timeline.trackDirectors[layerId] = 'default';
  template.timeline.propertyTrackDirectors = {
    [layerId]: { x: 'extra' },
  };
  template.timeline.keyframes = [
    {
      id: 'shared',
      frame: 0,
      layers: { [layerId]: { x: 12, y: 34 } },
      groups: {},
      easing: 'linear',
    },
  ];
  const sample = sampleAt(normalizeTimeline(template.timeline), 0);
  assert.equal(sample.directors.extra?.layers[layerId]?.x, 12);
  assert.equal(sample.directors.extra?.layers[layerId]?.y, undefined);
  assert.equal(sample.directors.default?.layers[layerId]?.y, 34);
  assert.equal(sample.directors.default?.layers[layerId]?.x, undefined);
  assert.equal(sample.layers[layerId]?.x, 12);
  assert.equal(sample.layers[layerId]?.y, 34);
});
