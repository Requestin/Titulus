import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultTemplate } from '@runtime';
import { useEditor } from './store';

test('addLayer crawl attaches a dedicated director and crawlProgress keys', () => {
  useEditor.getState().load(createDefaultTemplate());
  useEditor.getState().addLayer('crawl');
  const template = useEditor.getState().template!;
  const layer = template.layers.find((item) => item.type === 'crawl');
  assert.ok(layer && layer.type === 'crawl');
  assert.ok(template.timeline.directors.some((item) => item.id === layer.crawlDirectorId));
  assert.equal(template.timeline.propertyTrackDirectors?.[layer.id]?.crawlProgress, layer.crawlDirectorId);
  const values = template.timeline.keyframes.flatMap((key) => (
    key.layers[layer.id]?.crawlProgress === undefined ? [] : [key.layers[layer.id]!.crawlProgress]
  ));
  assert.deepEqual(values.sort(), [0, 1]);
});

test('updateLayer to continuous prunes leftover crawlProgress keys', () => {
  useEditor.getState().load(createDefaultTemplate());
  useEditor.getState().addLayer('crawl');
  const layerId = useEditor.getState().template!.layers.find((item) => item.type === 'crawl')!.id;
  useEditor.getState().patch((template) => {
    template.timeline.keyframes.push(
      { id: 'stale-mid', frame: 72, layers: { [layerId]: { crawlProgress: 1 } }, groups: {}, easing: 'linear' },
      { id: 'stale-end', frame: 198, layers: { [layerId]: { crawlProgress: 1 } }, groups: {}, easing: 'linear' },
    );
  });
  useEditor.getState().updateLayer(layerId, (layer) => {
    if (layer.type === 'crawl') layer.crawl.animationType = 'continuous';
  });
  const template = useEditor.getState().template!;
  const layer = template.layers.find((item) => item.id === layerId);
  assert.ok(layer && layer.type === 'crawl');
  const keys = template.timeline.keyframes
    .filter((key) => key.layers[layerId]?.crawlProgress !== undefined)
    .map((key) => [key.frame, key.layers[layerId]!.crawlProgress]);
  const director = template.timeline.directors.find((item) => item.id === layer.crawlDirectorId);
  assert.ok(director);
  assert.deepEqual(keys, [[0, 0], [director.durationFrames, 1]]);
  assert.equal(director.loop, true);
});

test('load recomputes stale crawl director duration from content, box and speed', () => {
  useEditor.getState().load(createDefaultTemplate());
  useEditor.getState().addLayer('crawl');
  const created = useEditor.getState().template!.layers.find((item) => item.type === 'crawl');
  if (!created || created.type !== 'crawl') throw new Error('expected crawl');
  const layerId = created.id;
  const directorId = created.crawlDirectorId;
  useEditor.getState().patch((template) => {
    const director = template.timeline.directors.find((item) => item.id === directorId);
    if (director) director.durationFrames = 250;
  });
  const snapshot = structuredClone(useEditor.getState().template!);
  useEditor.getState().load(snapshot);
  const template = useEditor.getState().template!;
  const layer = template.layers.find((item) => item.id === layerId);
  assert.ok(layer && layer.type === 'crawl');
  const director = template.timeline.directors.find((item) => item.id === layer.crawlDirectorId);
  assert.ok(director);
  assert.notEqual(director.durationFrames, 250);
});

test('manual Dur on a crawl director snaps back to the computed length', () => {
  useEditor.getState().load(createDefaultTemplate());
  useEditor.getState().addLayer('crawl');
  const layer = useEditor.getState().template!.layers.find((item) => item.type === 'crawl');
  assert.ok(layer && layer.type === 'crawl');
  const before = useEditor.getState().template!.timeline.directors.find((item) => item.id === layer.crawlDirectorId)!.durationFrames;
  useEditor.getState().updateDirector(layer.crawlDirectorId, { durationFrames: 200 });
  const after = useEditor.getState().template!.timeline.directors.find((item) => item.id === layer.crawlDirectorId)!.durationFrames;
  assert.equal(after, before);
  assert.notEqual(after, 200);
});

test('changing crawl speed recomputes director duration', () => {
  useEditor.getState().load(createDefaultTemplate());
  useEditor.getState().addLayer('crawl');
  const layer = useEditor.getState().template!.layers.find((item) => item.type === 'crawl');
  assert.ok(layer && layer.type === 'crawl');
  const slow = useEditor.getState().template!.timeline.directors.find((item) => item.id === layer.crawlDirectorId)!.durationFrames;
  useEditor.getState().updateLayer(layer.id, (item) => {
    if (item.type === 'crawl') item.crawl.speed = 10;
  });
  const fast = useEditor.getState().template!.timeline.directors.find((item) => item.id === layer.crawlDirectorId)!.durationFrames;
  assert.ok(fast < slow);
});
