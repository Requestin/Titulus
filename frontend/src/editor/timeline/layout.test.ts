import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultTemplate } from '@runtime';
import { createLayer } from '../factories';
import { collectTracks } from '../timelineTracks';
import {
  GROUP_HDR_H,
  LANE_H,
  TIMELINE_ANIMATABLE_PROPS,
  buildLaneLayout,
  keyframeHits,
  parseTimelineDrag,
  serializeTimelineDrag,
} from './layout';

test('timeline +K list includes z after the classic transform props', () => {
  assert.ok((TIMELINE_ANIMATABLE_PROPS as readonly string[]).includes('z'));
  assert.ok((TIMELINE_ANIMATABLE_PROPS as readonly string[]).indexOf('z') > (TIMELINE_ANIMATABLE_PROPS as readonly string[]).indexOf('opacity') || TIMELINE_ANIMATABLE_PROPS.includes('z'));
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
