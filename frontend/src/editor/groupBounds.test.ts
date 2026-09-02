import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultTemplate, createDefaultTransform } from '@runtime';
import { createLayer } from './factories';
import { derivedGroupBox, descendantLayerIds, layerBoxInCanvas, unionBoxes } from './groupBounds';
import { ancestorMatrix } from './transformMath';

function groupTemplate() {
  const template = createDefaultTemplate();
  const group = {
    id: 'group',
    name: 'Group',
    parentId: null,
    visible: true,
    locked: false,
    transform: { ...createDefaultTransform(100, 40), width: 1, height: 1 },
  };
  const inner = {
    id: 'inner',
    name: 'Inner',
    parentId: 'group',
    visible: true,
    locked: false,
    transform: { ...createDefaultTransform(10, 5), width: 1, height: 1 },
  };
  const a = createLayer('rect', 'A');
  a.id = 'a';
  a.groupId = 'group';
  a.transform = { ...createDefaultTransform(20, 10), width: 200, height: 80, anchorX: 0, anchorY: 0 };
  const b = createLayer('rect', 'B');
  b.id = 'b';
  b.groupId = 'inner';
  b.transform = { ...createDefaultTransform(30, 20), width: 40, height: 20, anchorX: 0, anchorY: 0 };
  template.groups.push(group, inner);
  template.layers.push(a, b);
  template.rootStack.push({ kind: 'group', id: 'group' });
  template.groupStacks.group = [{ kind: 'layer', id: 'a' }, { kind: 'group', id: 'inner' }];
  template.groupStacks.inner = [{ kind: 'layer', id: 'b' }];
  return template;
}

test('unionBoxes returns the inclusive AABB and does not mutate inputs', () => {
  const first = { x: 10, y: 20, width: 40, height: 10 };
  const second = { x: 5, y: 8, width: 10, height: 4 };
  assert.deepEqual(unionBoxes([first, second]), { x: 5, y: 8, width: 45, height: 22 });
  assert.deepEqual(first, { x: 10, y: 20, width: 40, height: 10 });
  assert.equal(unionBoxes([]), null);
});

test('descendantLayerIds walks nested groups without rewriting the document', () => {
  const template = groupTemplate();
  assert.deepEqual(descendantLayerIds(template, 'group'), ['a', 'b']);
  assert.deepEqual(template.groupStacks.group, [{ kind: 'layer', id: 'a' }, { kind: 'group', id: 'inner' }]);
});

test('derivedGroupBox unions descendant layer boxes in canvas space from 1x1 group size', () => {
  const template = groupTemplate();
  const box = derivedGroupBox(
    template,
    'group',
    (id) => template.layers.find((layer) => layer.id === id)!.transform,
    (id) => template.groups.find((group) => group.id === id)!.transform,
  );
  // group (100,40) + layer A (20,10,200x80) => (120,50,200x80)
  // inner (10,5) + layer B (30,20,40x20) => (140,65,40x20)
  assert.deepEqual(box, { x: 120, y: 50, width: 200, height: 80 });
  assert.equal(template.layers.find((layer) => layer.id === 'a')!.transform.x, 20);
  assert.equal(template.groups.find((group) => group.id === 'group')!.transform.width, 1);
});

test('derivedGroupBox follows a previewed group translate without changing child geometry', () => {
  const template = groupTemplate();
  const preview = { ...template.groups[0]!.transform, x: 140, y: 70 };
  const box = derivedGroupBox(
    template,
    'group',
    (id) => template.layers.find((layer) => layer.id === id)!.transform,
    (id) => (id === 'group' ? preview : template.groups.find((group) => group.id === id)!.transform),
  );
  assert.deepEqual(box, { x: 160, y: 80, width: 200, height: 80 });
  assert.equal(template.layers.find((layer) => layer.id === 'a')!.transform.x, 20);
  assert.equal(template.layers.find((layer) => layer.id === 'b')!.transform.x, 30);
});

test('layerBoxInCanvas applies ancestor group translation', () => {
  const template = groupTemplate();
  const layer = template.layers.find((item) => item.id === 'a')!;
  const box = layerBoxInCanvas(
    layer.transform,
    ancestorMatrix(template, layer.groupId, (group) => group.transform),
  );
  assert.equal(box.x, 120);
  assert.equal(box.y, 50);
  assert.equal(box.width, 200);
  assert.equal(box.height, 80);
});

test('derivedGroupBox is null for a group with no descendant layers', () => {
  const template = createDefaultTemplate();
  template.groups.push({
    id: 'empty',
    name: 'Empty',
    parentId: null,
    visible: true,
    locked: false,
    transform: createDefaultTransform(0, 0),
  });
  template.groupStacks.empty = [];
  assert.equal(
    derivedGroupBox(template, 'empty', () => createDefaultTransform(), () => createDefaultTransform()),
    null,
  );
});
