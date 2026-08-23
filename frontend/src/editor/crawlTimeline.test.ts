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
