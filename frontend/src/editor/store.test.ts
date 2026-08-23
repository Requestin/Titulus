import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultTemplate, createDefaultTransform } from '@runtime';
import { createLayer, LAYER_DEFAULT_DIMENSIONS, LAYER_TYPES } from './factories';
import { affineFromTransform, multiplyAffine } from './transformMath';
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

test('reparenting a layer preserves its world geometry at the current playhead', () => {
  const template = createDefaultTemplate();
  const layer = createLayer('rect', 'Rectangle');
  layer.id = 'rectangle';
  layer.transform.x = 320;
  layer.transform.y = 180;
  const group = {
    id: 'group',
    name: 'Group',
    parentId: null,
    visible: true,
    locked: false,
    transform: {
      ...createDefaultTransform(120, 80),
      width: 1,
      height: 1,
      rotation: 20,
      scaleX: 1.5,
      scaleY: 1.5,
    },
  };
  template.layers.push(layer);
  template.groups.push(group);
  template.rootStack.push({ kind: 'layer', id: layer.id }, { kind: 'group', id: group.id });
  useEditor.getState().load(template);

  const worldBefore = affineFromTransform(layer.transform);
  useEditor.getState().setLayerGroup(layer.id, group.id);

  const updated = useEditor.getState().template!;
  const reparented = updated.layers.find((item) => item.id === layer.id)!;
  const parent = updated.groups.find((item) => item.id === group.id)!;
  const worldAfter = multiplyAffine(affineFromTransform(parent.transform), affineFromTransform(reparented.transform));
  for (const key of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
    assert.ok(Math.abs(worldBefore[key] - worldAfter[key]) < 1e-8, key);
  }
});

test('deleting a group reparents its children without moving them', () => {
  const template = createDefaultTemplate();
  const layer = createLayer('rect', 'Rectangle');
  layer.id = 'rectangle';
  layer.groupId = 'group';
  const group = {
    id: 'group',
    name: 'Group',
    parentId: null,
    visible: true,
    locked: false,
    transform: {
      ...createDefaultTransform(90, 40),
      width: 1,
      height: 1,
      rotation: -15,
      scaleX: 1.2,
      scaleY: 1.2,
    },
  };
  template.layers.push(layer);
  template.groups.push(group);
  template.rootStack.push({ kind: 'group', id: group.id });
  template.groupStacks[group.id] = [{ kind: 'layer', id: layer.id }];
  useEditor.getState().load(template);
  const worldBefore = multiplyAffine(affineFromTransform(group.transform), affineFromTransform(layer.transform));

  useEditor.getState().select({ kind: 'group', id: group.id });
  useEditor.getState().deleteSelected();

  const updated = useEditor.getState().template!;
  const released = updated.layers.find((item) => item.id === layer.id)!;
  assert.equal(released.groupId, null);
  const worldAfter = affineFromTransform(released.transform);
  for (const key of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
    assert.ok(Math.abs(worldBefore[key] - worldAfter[key]) < 1e-8, key);
  }
});

test('each layer type exposes its own size reset defaults', () => {
  for (const type of LAYER_TYPES) {
    const layer = createLayer(type, type);
    assert.equal(layer.transform.width, LAYER_DEFAULT_DIMENSIONS[type].width);
    assert.equal(layer.transform.height, LAYER_DEFAULT_DIMENSIONS[type].height);
  }
});

test("editing a tracked z writes the current keyframe and leaves the base unchanged", () => {
  const template = createDefaultTemplate();
  const layer = createLayer("rect", "Animated rectangle");
  layer.id = "animated-rectangle";
  template.layers.push(layer);
  template.rootStack.push({ kind: "layer", id: layer.id });
  template.timeline.keyframes.push({
    id: "start",
    frame: 0,
    layers: { [layer.id]: { z: 8 } },
    groups: {},
    easing: "power2.out",
  });
  template.timeline.trackDirectors[layer.id] = "default";
  useEditor.getState().load(template);
  useEditor.getState().setPlayhead(20);

  useEditor.getState().updateTransform(layer.id, { z: 40 });

  const updated = useEditor.getState().template!;
  const current = updated.timeline.keyframes.find((keyframe) => keyframe.frame === 20)!;
  assert.equal(updated.layers.find((item) => item.id === layer.id)!.transform.z, undefined);
  assert.equal(current.layers[layer.id]?.z, 40);
});

test('duplicateSelected copies a tracked layer including keyframes and track assignment', () => {
  const { id } = loadAnimatedRectangle();
  useEditor.getState().select({ kind: 'layer', id });
  useEditor.getState().duplicateSelected();

  const template = useEditor.getState().template!;
  const copy = template.layers.find((item) => item.id !== id)!;
  assert.equal(template.layers.length, 2);
  assert.equal(copy.name, 'Animated rectangle copy');
  assert.equal(copy.transform.x, template.layers.find((item) => item.id === id)!.transform.x + 24);
  assert.equal(template.timeline.trackDirectors[copy.id], 'default');
  assert.equal(template.timeline.keyframes[0]!.layers[copy.id]?.x, template.timeline.keyframes[0]!.layers[id]?.x);
  assert.equal(useEditor.getState().selection?.id, copy.id);
});

test('duplicateSelected deep-copies a group subtree and its timeline in one patch', () => {
  const template = createDefaultTemplate();
  const group = {
    id: 'group',
    name: 'Folder',
    parentId: null,
    visible: true,
    locked: false,
    transform: createDefaultTransform(10, 20),
  };
  const layer = createLayer('rect', 'Inside');
  layer.id = 'inside';
  layer.groupId = 'group';
  template.groups.push(group);
  template.layers.push(layer);
  template.rootStack.push({ kind: 'group', id: 'group' });
  template.groupStacks.group = [{ kind: 'layer', id: 'inside' }];
  template.timeline.trackDirectors.inside = 'default';
  template.timeline.keyframes.push({
    id: 'kf',
    frame: 0,
    layers: { inside: { y: 33 } },
    groups: {},
    easing: 'linear',
  });
  useEditor.getState().load(template);
  useEditor.getState().select({ kind: 'group', id: 'group' });

  useEditor.getState().duplicateSelected();

  const updated = useEditor.getState().template!;
  const copyGroup = updated.groups.find((item) => item.id !== 'group')!;
  const copyLayer = updated.layers.find((item) => item.id !== 'inside')!;
  assert.equal(updated.groups.length, 2);
  assert.equal(updated.layers.length, 2);
  assert.equal(copyGroup.name, 'Folder copy');
  assert.equal(copyLayer.groupId, copyGroup.id);
  assert.deepEqual(updated.groupStacks[copyGroup.id], [{ kind: 'layer', id: copyLayer.id }]);
  assert.equal(updated.timeline.trackDirectors[copyLayer.id], 'default');
  assert.equal(updated.timeline.keyframes[0]!.layers[copyLayer.id]?.y, 33);
  assert.equal(updated.timeline.keyframes[0]!.layers.inside?.y, 33);
  assert.equal(useEditor.getState().selection?.id, copyGroup.id);
});

test('moving a group writes only the group transform and leaves child geometry untouched', () => {
  const template = createDefaultTemplate();
  const group = {
    id: 'group',
    name: 'Group',
    parentId: null,
    visible: true,
    locked: false,
    transform: createDefaultTransform(40, 60),
  };
  const layer = createLayer('rect', 'Child');
  layer.id = 'child';
  layer.groupId = 'group';
  layer.transform.x = 12;
  layer.transform.y = 8;
  template.groups.push(group);
  template.layers.push(layer);
  template.rootStack.push({ kind: 'group', id: 'group' });
  template.groupStacks.group = [{ kind: 'layer', id: 'child' }];
  useEditor.getState().load(template);

  useEditor.getState().updateTransform('group', { x: 90, y: 75 }, 'group');

  const updated = useEditor.getState().template!;
  assert.equal(updated.groups[0]!.transform.x, 90);
  assert.equal(updated.groups[0]!.transform.y, 75);
  assert.equal(updated.layers[0]!.transform.x, 12);
  assert.equal(updated.layers[0]!.transform.y, 8);
});

test('duplicateSelected remaps a crawl director instead of sharing it', () => {
  useEditor.getState().load(createDefaultTemplate());
  useEditor.getState().addLayer('crawl');
  const first = useEditor.getState().template!.layers[0];
  assert.equal(first?.type, 'crawl');
  if (first?.type !== 'crawl') return;
  const firstDirector = first.crawlDirectorId;
  useEditor.getState().duplicateSelected();
  const template = useEditor.getState().template!;
  const crawls = template.layers.filter((layer) => layer.type === 'crawl');
  assert.equal(crawls.length, 2);
  assert.notEqual(crawls[0]!.crawlDirectorId, crawls[1]!.crawlDirectorId);
  assert.ok(template.timeline.directors.some((director) => director.id === crawls[0]!.crawlDirectorId));
  assert.ok(template.timeline.directors.some((director) => director.id === crawls[1]!.crawlDirectorId));
  assert.notEqual(firstDirector, crawls.find((layer) => layer.id !== first.id)?.crawlDirectorId);
});

test('deleteSelected removes an orphan crawl director', () => {
  useEditor.getState().load(createDefaultTemplate());
  useEditor.getState().addLayer('crawl');
  const crawl = useEditor.getState().template!.layers[0];
  assert.equal(crawl?.type, 'crawl');
  if (crawl?.type !== 'crawl') return;
  const directorId = crawl.crawlDirectorId;
  useEditor.getState().deleteSelected();
  const template = useEditor.getState().template!;
  assert.equal(template.layers.length, 0);
  assert.equal(template.timeline.directors.some((director) => director.id === directorId), false);
});

test('commitCurveDrag writes value and frame in one patch', () => {
  const { id } = loadAnimatedRectangle();
  useEditor.getState().commitCurveDrag({ kind: 'layer', id }, 'x', 0, 12, 77);
  const template = useEditor.getState().template!;
  assert.equal(template.timeline.keyframes.some((keyframe) => keyframe.frame === 0 && keyframe.layers[id]?.x !== undefined), false);
  const moved = template.timeline.keyframes.find((keyframe) => keyframe.frame === 12);
  assert.equal(moved?.layers[id]?.x, 77);
});
