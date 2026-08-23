import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultTemplate, createDefaultTransform } from '@runtime';
import { createLayer } from './factories';
import {
  applyClonedTree,
  cloneTreeSelection,
  insertTreeEntries,
  normalizeTreeSelection,
  type TreeRef,
} from './treeClipboard';

function ids(): () => string {
  let n = 0;
  return () => `copy-${++n}`;
}

function nestedTemplate() {
  const template = createDefaultTemplate();
  const group = {
    id: 'group',
    name: 'Outer',
    parentId: null,
    visible: true,
    locked: false,
    transform: createDefaultTransform(40, 60),
  };
  const inner = {
    id: 'inner',
    name: 'Inner',
    parentId: 'group',
    visible: true,
    locked: false,
    transform: createDefaultTransform(8, 12),
  };
  const child = createLayer('rect', 'Child');
  child.id = 'child';
  child.groupId = 'inner';
  child.transform.x = 200;
  child.transform.y = 80;
  const sibling = createLayer('text', 'Sibling');
  sibling.id = 'sibling';
  sibling.groupId = null;
  template.groups.push(group, inner);
  template.layers.push(child, sibling);
  template.rootStack.push({ kind: 'group', id: 'group' }, { kind: 'layer', id: 'sibling' });
  template.groupStacks.group = [{ kind: 'group', id: 'inner' }];
  template.groupStacks.inner = [{ kind: 'layer', id: 'child' }];
  template.timeline.trackDirectors.child = 'default';
  template.timeline.trackDirectors.group = 'default';
  template.timeline.keyframes.push({
    id: 'kf0',
    frame: 0,
    layers: { child: { x: 10 } },
    groups: { group: { y: 4 } },
    easing: 'power2.out',
  });
  return template;
}

test('normalizeTreeSelection drops descendants when an ancestor group is selected', () => {
  const template = nestedTemplate();
  const selected: TreeRef[] = [
    { kind: 'group', id: 'group' },
    { kind: 'group', id: 'inner' },
    { kind: 'layer', id: 'child' },
    { kind: 'layer', id: 'sibling' },
  ];

  assert.deepEqual(normalizeTreeSelection(template, selected), [
    { kind: 'group', id: 'group' },
    { kind: 'layer', id: 'sibling' },
  ]);
});

test('normalizeTreeSelection falls back to the active entry when it is not checked', () => {
  const template = nestedTemplate();
  assert.deepEqual(
    normalizeTreeSelection(template, [{ kind: 'layer', id: 'sibling' }], { kind: 'group', id: 'inner' }),
    [{ kind: 'group', id: 'inner' }],
  );
});

test('cloneTreeSelection remaps a group subtree, tracks and keyframes without mutating the source', () => {
  const template = nestedTemplate();
  const cloned = cloneTreeSelection(template, [{ kind: 'group', id: 'group' }], {
    createId: ids(),
    offset: { x: 24, y: 24 },
  });

  assert.deepEqual(cloned.roots, [{ kind: 'group', id: 'copy-1' }]);
  assert.equal(cloned.idMap.group, 'copy-1');
  assert.equal(cloned.idMap.inner, 'copy-2');
  assert.equal(cloned.idMap.child, 'copy-3');
  assert.equal(cloned.groups.find((g) => g.id === 'copy-1')!.name, 'Outer copy');
  assert.equal(cloned.groups.find((g) => g.id === 'copy-1')!.transform.x, 64);
  assert.equal(cloned.groups.find((g) => g.id === 'copy-1')!.transform.y, 84);
  assert.equal(cloned.groups.find((g) => g.id === 'copy-2')!.parentId, 'copy-1');
  assert.equal(cloned.layers[0]!.id, 'copy-3');
  assert.equal(cloned.layers[0]!.name, 'Child copy');
  assert.equal(cloned.layers[0]!.groupId, 'copy-2');
  assert.equal(cloned.layers[0]!.transform.x, 200);
  assert.deepEqual(cloned.groupStacks['copy-1'], [{ kind: 'group', id: 'copy-2' }]);
  assert.deepEqual(cloned.groupStacks['copy-2'], [{ kind: 'layer', id: 'copy-3' }]);
  assert.equal(template.groups.length, 2);
  assert.equal(template.layers.length, 2);
  assert.equal(template.timeline.keyframes[0]!.layers.child?.x, 10);
});

test('applyClonedTree inserts copies and remaps timeline bags in one document', () => {
  const template = nestedTemplate();
  const cloned = cloneTreeSelection(template, [{ kind: 'group', id: 'group' }], { createId: ids() });

  applyClonedTree(template, cloned);

  assert.equal(template.groups.some((g) => g.id === 'copy-1'), true);
  assert.equal(template.layers.some((l) => l.id === 'copy-3'), true);
  assert.equal(template.timeline.trackDirectors['copy-1'], 'default');
  assert.equal(template.timeline.trackDirectors['copy-3'], 'default');
  assert.equal(template.timeline.trackDirectors.child, 'default');
  assert.equal(template.timeline.keyframes[0]!.layers['copy-3']?.x, 10);
  assert.equal(template.timeline.keyframes[0]!.groups['copy-1']?.y, 4);
  assert.equal(template.timeline.keyframes[0]!.layers.child?.x, 10);
  assert.deepEqual(template.rootStack.map((e) => e.id), ['group', 'sibling', 'copy-1']);
});

test('insertTreeEntries places copied roots inside a group without creating a cycle on the originals', () => {
  const template = nestedTemplate();
  const cloned = cloneTreeSelection(template, [{ kind: 'layer', id: 'sibling' }], { createId: ids() });
  applyClonedTree(template, cloned, { insert: false });
  insertTreeEntries(template, cloned.roots, { type: 'inside', groupId: 'group' });

  assert.equal(template.layers.find((l) => l.id === 'copy-1')!.groupId, 'group');
  assert.deepEqual(template.groupStacks.group.map((e) => e.id), ['inner', 'copy-1']);
  assert.equal(template.rootStack.some((e) => e.id === 'copy-1'), false);
  assert.equal(template.rootStack.some((e) => e.id === 'sibling'), true);
});
