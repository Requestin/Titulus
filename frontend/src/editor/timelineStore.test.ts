import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultTemplate } from '@runtime';
import { createLayer } from './factories';
import { useEditor } from './store';
import { playheadStore, setLivePlayhead } from './playheadStore';
import { directorForTrack, pointsFor } from './timelineTracks';

function loadTwoKeys() {
  const template = createDefaultTemplate();
  const layer = createLayer('rect', 'Box');
  layer.id = 'box';
  template.layers.push(layer);
  template.rootStack.push({ kind: 'layer', id: layer.id });
  template.timeline.trackDirectors[layer.id] = 'default';
  template.timeline.directors.push({
    id: 'extra',
    name: 'Director 2',
    durationFrames: 100,
    offsetFrames: 0,
    autostart: true,
    loop: false,
    swing: false,
  });
  template.timeline.keyframes.push(
    { id: 'a', frame: 0, layers: { box: { x: 10, y: 4 } }, groups: {}, easing: 'linear' },
    { id: 'b', frame: 20, layers: { box: { x: 30 } }, groups: {}, easing: 'linear' },
  );
  useEditor.getState().load(template);
  return { target: { kind: 'layer' as const, id: 'box' } };
}

test('selected keyframes stay out of zundo and move in one history entry', () => {
  const { target } = loadTwoKeys();
  const before = useEditor.temporal.getState().pastStates.length;
  useEditor.getState().setSelectedKeyframes([
    { target, prop: 'x', frame: 0 },
    { target, prop: 'x', frame: 20 },
  ]);
  assert.equal(useEditor.temporal.getState().pastStates.length, before);
  useEditor.getState().moveSelectedKeyframes(10);
  assert.equal(useEditor.temporal.getState().pastStates.length, before + 1);
  const template = useEditor.getState().template!;
  assert.deepEqual(pointsFor(template, target, 'x').map((item) => item.frame), [10, 30]);
  useEditor.temporal.getState().undo();
  assert.deepEqual(pointsFor(useEditor.getState().template!, target, 'x').map((item) => item.frame), [0, 20]);
});

test('assignPropertyDirector and +K/−K write one patch each', () => {
  const { target } = loadTwoKeys();
  const before = useEditor.temporal.getState().pastStates.length;
  useEditor.getState().assignPropertyDirector(target, 'x', 'extra');
  assert.equal(directorForTrack(useEditor.getState().template!.timeline, target, 'x'), 'extra');
  useEditor.getState().setPlayhead(8);
  useEditor.getState().addKeyframeAtPlayhead(target, 'x');
  useEditor.getState().setSelectedKeyframes([{ target, prop: 'y', frame: 0 }]);
  useEditor.getState().deleteSelectedKeyframes();
  assert.equal(useEditor.temporal.getState().pastStates.length, before + 3);
  const template = useEditor.getState().template!;
  assert.ok(pointsFor(template, target, 'x').some((item) => item.frame === 8));
  assert.equal(pointsFor(template, target, 'y').length, 0);
});

test('stretchObjectSummary is one undoable gesture', () => {
  const { target } = loadTwoKeys();
  const before = useEditor.temporal.getState().pastStates.length;
  useEditor.getState().stretchObjectSummary(target, 'end', 40);
  assert.equal(useEditor.temporal.getState().pastStates.length, before + 1);
  assert.deepEqual(
    pointsFor(useEditor.getState().template!, target, 'x').map((item) => item.frame),
    [0, 40],
  );
});

test('live playhead does not mutate the editor store', () => {
  loadTwoKeys();
  useEditor.getState().setPlayhead(4);
  const storeFrame = useEditor.getState().playhead;
  setLivePlayhead(19.4);
  assert.equal(useEditor.getState().playhead, storeFrame);
  assert.equal(playheadStore.getState().playhead, 19);
});
