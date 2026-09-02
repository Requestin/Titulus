import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultTemplate } from '@runtime';
import { createLayer } from './factories';
import {
  applyKeyframeMoves,
  assignPropertyDirector,
  collectTracks,
  directorForTrack,
  groupTracksByTarget,
  keyframeKey,
  planKeyframeMoves,
  pointsFor,
  trackKey,
  tracksForDirector,
  type SelectedKeyframe,
} from './timelineTracks';

function animatedRect() {
  const template = createDefaultTemplate();
  const layer = createLayer('rect', 'Box');
  layer.id = 'box';
  template.layers.push(layer);
  template.rootStack.push({ kind: 'layer', id: layer.id });
  template.timeline.trackDirectors[layer.id] = 'default';
  template.timeline.keyframes.push(
    { id: 'a', frame: 0, layers: { box: { x: 10, y: 20 } }, groups: {}, easing: 'linear' },
    { id: 'b', frame: 20, layers: { box: { x: 40 } }, groups: {}, easing: 'power2.out' },
    { id: 'c', frame: 40, layers: { box: { y: 80 } }, groups: {}, easing: 'linear' },
  );
  return template;
}

test('collectTracks lists each animated property once and groups them by object', () => {
  const template = animatedRect();
  const tracks = collectTracks(template);
  assert.deepEqual(tracks.map((item) => trackKey(item.target, item.prop)), [
    'layer:box:x',
    'layer:box:y',
  ]);
  const groups = groupTracksByTarget(template, tracks);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.label, 'Box');
  assert.deepEqual(groups[0]!.tracks.map((item) => item.prop), ['x', 'y']);
});

test('directorForTrack prefers a per-property override and otherwise uses the object director', () => {
  const template = animatedRect();
  template.timeline.directors.push({
    id: 'extra',
    name: 'Director 2',
    durationFrames: 100,
    offsetFrames: 0,
    autostart: true,
    loop: false,
    swing: false,
  });
  const target = { kind: 'layer' as const, id: 'box' };
  assert.equal(directorForTrack(template.timeline, target, 'x'), 'default');
  assignPropertyDirector(template.timeline, target, 'x', 'extra');
  assert.equal(directorForTrack(template.timeline, target, 'x'), 'extra');
  assert.equal(directorForTrack(template.timeline, target, 'y'), 'default');
  assert.deepEqual(
    tracksForDirector(template, 'extra').map((item) => item.prop),
    ['x'],
  );
  assignPropertyDirector(template.timeline, target, 'x', 'default');
  assert.equal(template.timeline.propertyTrackDirectors, undefined);
});

test('planKeyframeMoves overwrites a destination and keeps the later source on a same-track pile-up', () => {
  const template = animatedRect();
  const target = { kind: 'layer' as const, id: 'box' };
  const selected: SelectedKeyframe[] = [
    { target, prop: 'x', frame: 0 },
    { target, prop: 'x', frame: 20 },
  ];
  const piled = planKeyframeMoves(template, selected, -40);
  assert.deepEqual(piled, [
    { target, prop: 'x', fromFrame: 20, toFrame: 0, value: 40 },
  ]);

  const ontoOccupied = planKeyframeMoves(template, [{ target, prop: 'x', frame: 0 }], 20);
  assert.deepEqual(ontoOccupied, [
    { target, prop: 'x', fromFrame: 0, toFrame: 20, value: 10 },
  ]);
  applyKeyframeMoves(template, ontoOccupied);
  const xPoints = pointsFor(template, target, 'x');
  assert.deepEqual(xPoints.map((item) => [item.frame, item.value]), [[20, 10]]);
  assert.equal(template.timeline.keyframes.find((item) => item.frame === 0)?.layers.box?.x, undefined);
  assert.equal(template.timeline.keyframes.find((item) => item.frame === 0)?.layers.box?.y, 20);
});

test('keyframe identity is target+prop+frame', () => {
  const target = { kind: 'layer' as const, id: 'box' };
  assert.equal(keyframeKey({ target, prop: 'x', frame: 12 }), 'layer:box:x@12');
});

test('pointsFor reads per-property easing instead of the shared keyframe easing', () => {
  const template = createDefaultTemplate();
  const target = { kind: 'layer' as const, id: 'box' };
  template.timeline.keyframes.push({
    id: 'a',
    frame: 0,
    layers: { box: { x: 0, y: 0 } },
    groups: {},
    easing: 'linear',
    layerEasings: { box: { x: 'power2.in', y: 'linear' } },
  });
  assert.equal(pointsFor(template, target, 'x')[0]?.easing, 'power2.in');
  assert.equal(pointsFor(template, target, 'y')[0]?.easing, 'linear');
});

test('the same property can exist independently on two directors', () => {
  const template = animatedRect();
  template.timeline.directors.push({
    id: 'update',
    name: 'Update',
    durationFrames: 100,
    offsetFrames: 0,
    autostart: false,
    loop: false,
    swing: false,
  });
  template.timeline.keyframes.push({
    id: 'u',
    frame: 0,
    directorId: 'update',
    layers: { box: { x: 99 } },
    groups: {},
    easing: 'linear',
  });
  const target = { kind: 'layer' as const, id: 'box' };
  assert.deepEqual(tracksForDirector(template, 'default').map((item) => item.prop).sort(), ['x', 'y']);
  assert.deepEqual(tracksForDirector(template, 'update').map((item) => item.prop), ['x']);
  assert.deepEqual(pointsFor(template, target, 'x', 'default').map((item) => item.value), [10, 40]);
  assert.deepEqual(pointsFor(template, target, 'x', 'update').map((item) => item.value), [99]);
});
