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

test('shared-frame keyframe bags split by trackDirectors so Update text does not leak into default', () => {
  // Operator template pattern: group on default, text on Update, one keyframe
  // bag at the wait frame carries both. Pushing the whole bag into default made
  // sampleAt hold text x=-290 from frame 0 (invisible on TAKE) and again after
  // Update returned to idle while default stayed waiting at frame 50.
  const timeline = {
    fps: 50,
    durationFrames: 101,
    playbackMode: 'bounded' as const,
    directors: [
      { id: 'default', name: 'default', durationFrames: 101, offsetFrames: 0, autostart: true, loop: false, swing: false },
      { id: 'update', name: 'Update', durationFrames: 100, offsetFrames: 0, autostart: false, loop: false, swing: false },
    ],
    trackDirectors: {
      group: 'default',
      text: 'update',
    },
    keyframes: [
      { id: 'k0', frame: 0, layers: {}, groups: { group: { x: -424, y: -67 } }, easing: 'linear' as const },
      { id: 't3', frame: 3, layers: { text: { x: 147.49 } }, groups: {}, easing: 'linear' as const },
      { id: 't4', frame: 4, layers: { text: { x: 154 } }, groups: {}, easing: 'linear' as const },
      {
        id: 'k50',
        frame: 50,
        layers: { text: { x: -290 } },
        groups: { group: { x: 302.75, y: 118 } },
        easing: 'linear' as const,
      },
      { id: 't96', frame: 96, layers: { text: { x: 154 } }, groups: {}, easing: 'linear' as const },
      { id: 'k100', frame: 100, layers: {}, groups: { group: { x: -424, y: -67 } }, easing: 'linear' as const },
    ],
    actions: [],
    cues: [],
  };
  const norm = normalizeTimeline(timeline);
  assert.equal(norm.directors.default?.tracks.has('text'), false);
  assert.equal(norm.directors.default?.tracks.has('group'), true);
  assert.equal(norm.directors.update?.tracks.has('text'), true);
  assert.equal(norm.directors.update?.tracks.has('group'), false);

  const atWait = sampleAt(norm, 50);
  assert.equal(atWait.groups.group?.x, 302.75);
  assert.equal(atWait.directors.default?.layers.text, undefined);
  assert.equal(atWait.directors.update?.layers.text?.x, -290);
  // Default's merged overlay must not force text off-canvas before Update runs.
  assert.equal(atWait.directors.default?.layers.text?.x, undefined);
});

test('director-scoped keyframes keep an independent copy of the same property', () => {
  const template = structuredClone(test1);
  const layerId = template.layers[0]!.id;
  template.timeline.directors.push({
    id: 'extra',
    name: 'extra',
    durationFrames: template.timeline.durationFrames,
    offsetFrames: 0,
    autostart: true,
    loop: true,
    swing: false,
  });
  template.timeline.trackDirectors[layerId] = 'default';
  template.timeline.keyframes = [
    {
      id: 'in',
      frame: 0,
      layers: { [layerId]: { x: 10 } },
      groups: {},
      easing: 'linear',
    },
    {
      id: 'upd',
      frame: 0,
      directorId: 'extra',
      layers: { [layerId]: { x: 90 } },
      groups: {},
      easing: 'linear',
    },
  ];
  const sample = sampleAt(normalizeTimeline(template.timeline), 0);
  assert.equal(sample.directors.default?.layers[layerId]?.x, 10);
  assert.equal(sample.directors.extra?.layers[layerId]?.x, 90);
  assert.equal(sample.layers[layerId]?.x, 90);
});
