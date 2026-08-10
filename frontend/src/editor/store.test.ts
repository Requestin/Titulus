import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultTemplate } from '@runtime';
import { createLayer } from './factories';
import { useEditor } from './store';

function loadAnimatedRectangle() {
  const template = createDefaultTemplate();
  const layer = createLayer('rect', 'Animated rectangle');
  layer.id = 'animated-rectangle';
  template.layers.push(layer);
  template.rootStack.push({ kind: 'layer', id: layer.id });
  template.timeline.keyframes.push({
    id: 'start',
    frame: 0,
    layers: { [layer.id]: { x: layer.transform.x } },
    groups: {},
    easing: 'power2.out',
  });
  template.timeline.trackDirectors[layer.id] = 'default';
  useEditor.getState().load(template);
  useEditor.getState().setPlayhead(20);
  return { id: layer.id, baseX: layer.transform.x };
}

test('editing a tracked transform property leaves its base value unchanged', () => {
  const { id, baseX } = loadAnimatedRectangle();

  useEditor.getState().updateTransform(id, { x: 480, y: 320 });

  const template = useEditor.getState().template!;
  const layer = template.layers.find((item) => item.id === id)!;
  const current = template.timeline.keyframes.find((keyframe) => keyframe.frame === 20)!;
  assert.equal(layer.transform.x, baseX);
  assert.equal(layer.transform.y, 320);
  assert.equal(current.layers[id]?.x, 480);
});

test('resetting a tracked opacity only writes the current keyframe', () => {
  const { id } = loadAnimatedRectangle();
  const template = useEditor.getState().template!;
  const layer = template.layers.find((item) => item.id === id)!;
  layer.opacity = 0.42;
  template.timeline.keyframes[0]!.layers[id]!.opacity = 0.2;

  useEditor.getState().setLayerOpacity(id, 1);

  const updated = useEditor.getState().template!;
  const current = updated.timeline.keyframes.find((keyframe) => keyframe.frame === 20)!;
  assert.equal(updated.layers.find((item) => item.id === id)!.opacity, 0.42);
  assert.equal(current.layers[id]?.opacity, 1);
  assert.equal(updated.timeline.keyframes[0]!.layers[id]?.opacity, 0.2);
});
