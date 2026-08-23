import assert from 'node:assert/strict';
import test from 'node:test';
import {
  keyframesInMarquee,
  normalizeMarquee,
  toggleKeyframeSelection,
} from './timelineMarquee';

const a = { target: { kind: 'layer' as const, id: 'box' }, prop: 'x' as const, frame: 10 };
const b = { target: { kind: 'layer' as const, id: 'box' }, prop: 'y' as const, frame: 20 };
const c = { target: { kind: 'group' as const, id: 'folder' }, prop: 'rotation' as const, frame: 40 };

test('normalizeMarquee accepts any drag corner order', () => {
  assert.deepEqual(normalizeMarquee(80, 40, 10, 5), {
    left: 10,
    top: 5,
    right: 80,
    bottom: 40,
  });
});

test('keyframesInMarquee keeps hits whose diamond sits inside the rect', () => {
  const hits = [
    { ...a, x: 12, y: 8 },
    { ...b, x: 24, y: 30 },
    { ...c, x: 90, y: 8 },
  ];
  const inside = keyframesInMarquee(hits, normalizeMarquee(0, 0, 30, 20));
  assert.deepEqual(inside, [a]);
});

test('toggleKeyframeSelection replace/add/toggle stay deterministic', () => {
  assert.deepEqual(toggleKeyframeSelection([a], b, 'replace'), [b]);
  assert.deepEqual(toggleKeyframeSelection([a], b, 'add'), [a, b]);
  assert.deepEqual(toggleKeyframeSelection([a, b], a, 'toggle'), [b]);
  assert.deepEqual(toggleKeyframeSelection([a], a, 'toggle'), []);
  assert.deepEqual(toggleKeyframeSelection([a], a, 'add'), [a]);
});
