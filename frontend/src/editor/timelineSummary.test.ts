import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultTemplate } from '@runtime';
import { createLayer } from './factories';
import { applyKeyframeMoves, planStretchMoves, pointsFor } from './timelineTracks';
import { objectSummary, stretchSummaryKeys } from './timelineSummary';

function spanTemplate() {
  const template = createDefaultTemplate();
  const layer = createLayer('rect', 'Box');
  layer.id = 'box';
  template.layers.push(layer);
  template.rootStack.push({ kind: 'layer', id: layer.id });
  template.timeline.trackDirectors[layer.id] = 'default';
  template.timeline.keyframes.push(
    { id: 'a', frame: 10, layers: { box: { x: 0, y: 0 } }, groups: {}, easing: 'linear' },
    { id: 'b', frame: 30, layers: { box: { x: 20 } }, groups: {}, easing: 'linear' },
    { id: 'c', frame: 50, layers: { box: { y: 40 } }, groups: {}, easing: 'linear' },
  );
  return template;
}

test('objectSummary spans every key belonging to the object', () => {
  const template = spanTemplate();
  const summary = objectSummary(template, { kind: 'layer', id: 'box' });
  assert.ok(summary);
  assert.equal(summary.start, 10);
  assert.equal(summary.end, 50);
  assert.equal(summary.keys.length, 4);
});

test('stretchSummaryKeys scales inner keys proportionally from the moved edge', () => {
  const keys = [
    { target: { kind: 'layer' as const, id: 'box' }, prop: 'x' as const, frame: 10 },
    { target: { kind: 'layer' as const, id: 'box' }, prop: 'x' as const, frame: 30 },
    { target: { kind: 'layer' as const, id: 'box' }, prop: 'y' as const, frame: 50 },
  ];
  const stretched = stretchSummaryKeys(keys, 'end', 90);
  assert.deepEqual(stretched.map((item) => item.frame), [10, 50, 90]);
  const fromStart = stretchSummaryKeys(keys, 'start', 0);
  assert.deepEqual(fromStart.map((item) => item.frame), [0, 25, 50]);
});

test('planStretchMoves applies proportional stretch in one overwrite-safe batch', () => {
  const template = spanTemplate();
  const summary = objectSummary(template, { kind: 'layer', id: 'box' })!;
  const moves = planStretchMoves(template, summary.keys, 'end', 90);
  applyKeyframeMoves(template, moves);
  const target = { kind: 'layer' as const, id: 'box' };
  assert.deepEqual(pointsFor(template, target, 'x').map((item) => [item.frame, item.value]), [
    [10, 0],
    [50, 20],
  ]);
  assert.deepEqual(pointsFor(template, target, 'y').map((item) => [item.frame, item.value]), [
    [10, 0],
    [90, 40],
  ]);
});
