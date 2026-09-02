import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultTemplate } from '@runtime';
import { createLayer } from '../factories';
import { collectTracks } from '../timelineTracks';
import {
  ACTION_LANE_H,
  DIRECTOR_HDR_H,
  GROUP_HDR_H,
  LANE_H,
  TIMELINE_ANIMATABLE_PROPS,
  buildAllDirectorsLaneLayout,
  buildLaneLayout,
  keyframeHits,
  parseTimelineDrag,
  serializeTimelineDrag,
  timelinePropLabel,
} from './layout';

test('timeline +K list includes z after y', () => {
  assert.ok(TIMELINE_ANIMATABLE_PROPS.includes('z'));
  assert.equal(TIMELINE_ANIMATABLE_PROPS.indexOf('z'), TIMELINE_ANIMATABLE_PROPS.indexOf('y') + 1);
});

test('timelinePropLabel renames rotation to rotationZ', () => {
  assert.equal(timelinePropLabel('rotation'), 'rotationZ');
  assert.equal(timelinePropLabel('rotationX'), 'rotationX');
  assert.equal(timelinePropLabel('gradient.weights.topLeft'), 'Weight TL');
});

test('buildLaneLayout stacks object headers and property lanes', () => {
  const template = createDefaultTemplate();
  const layer = createLayer('rect', 'Box');
  layer.id = 'box';
  template.layers.push(layer);
  template.timeline.keyframes.push({
    id: 'a',
    frame: 8,
    layers: { box: { x: 1, y: 2 } },
    groups: {},
    easing: 'linear',
  });
  const layout = buildLaneLayout(template, collectTracks(template), 6);
  assert.equal(layout.rows[0]?.kind, 'group');
  assert.equal(layout.rows[1]?.kind, 'track');
  assert.equal(layout.height, GROUP_HDR_H + LANE_H * 2);
  const hits = keyframeHits(template, layout.rows, 6);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]?.x, 8 * 6);
});

test('timeline drag payload round-trips track and object drops', () => {
  const track = serializeTimelineDrag({ type: 'track', target: { kind: 'layer', id: 'box' }, prop: 'x' });
  assert.deepEqual(parseTimelineDrag(track), { type: 'track', target: { kind: 'layer', id: 'box' }, prop: 'x' });
  const object = serializeTimelineDrag({ type: 'object', target: { kind: 'group', id: 'folder' } });
  assert.deepEqual(parseTimelineDrag(object), { type: 'object', target: { kind: 'group', id: 'folder' } });
  assert.equal(parseTimelineDrag('nope'), null);
});

test('each expanded director gets an Action lane', () => {
  const template = createDefaultTemplate();
  const layout = buildAllDirectorsLaneLayout(template, template.timeline.directors, new Set(), 6);
  const actions = layout.rows.filter((row) => row.kind === 'action');
  assert.equal(actions.length, template.timeline.directors.length);
  assert.equal(layout.rows[0]?.kind, 'director');
  assert.equal(layout.rows[1]?.kind, 'action');
  assert.equal(layout.rows[1]?.kind === 'action' && layout.rows[1].height, ACTION_LANE_H);
  assert.ok(layout.height >= DIRECTOR_HDR_H + ACTION_LANE_H);
});

test('gradient weight props are addable timeline tracks', () => {
  assert.ok(TIMELINE_ANIMATABLE_PROPS.includes('gradient.weights.topLeft'));
  assert.ok(TIMELINE_ANIMATABLE_PROPS.includes('gradient.weights.bottomRight'));
});
