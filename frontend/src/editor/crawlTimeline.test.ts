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
