import type { Layer, LayerGroup, RootStackEntry, Template, Transform } from '@runtime';
import { createId } from '@/core/id';
import { attachCrawlTimeline } from './crawlTimeline';

export type TreeRef = { kind: 'layer' | 'group'; id: string };

export interface ClonedTree {
  layers: Layer[];
  groups: LayerGroup[];
  groupStacks: Record<string, RootStackEntry[]>;
  roots: TreeRef[];
  idMap: Record<string, string>;
}

export type TreeInsert =
  | { type: 'inside'; groupId: string }
  | { type: 'before' | 'after'; key: string };

function containerEntries(template: Template, containerId: string | null): RootStackEntry[] {
  return containerId === null ? template.rootStack : (template.groupStacks[containerId] ?? []);
}

function setContainerEntries(template: Template, containerId: string | null, entries: RootStackEntry[]): void {
  if (containerId === null) template.rootStack = entries;
  else template.groupStacks[containerId] = entries;
}

export function treeKey(ref: TreeRef): `${TreeRef['kind']}:${string}` {
  return `${ref.kind}:${ref.id}`;
}

export function parseTreeKey(key: string): TreeRef | null {
  const [kind, id] = key.split(':');
  if ((kind !== 'layer' && kind !== 'group') || !id) return null;
  return { kind, id };
}

export function findTreeContainer(template: Template, id: string): string | null | undefined {
  if (template.rootStack.some((entry) => entry.id === id)) return null;
  for (const [groupId, entries] of Object.entries(template.groupStacks)) {
    if (entries.some((entry) => entry.id === id)) return groupId;
  }
  return undefined;
}

function parentIdOf(template: Template, ref: TreeRef): string | null {
  if (ref.kind === 'layer') return template.layers.find((layer) => layer.id === ref.id)?.groupId ?? null;
  return template.groups.find((group) => group.id === ref.id)?.parentId ?? null;
}

export function hasSelectedAncestor(
  template: Template,
  ref: TreeRef,
  selected: Set<string>,
): boolean {
  let parentId = parentIdOf(template, ref);
  while (parentId) {
    if (selected.has(`group:${parentId}`)) return true;
    parentId = template.groups.find((group) => group.id === parentId)?.parentId ?? null;
  }
  return false;
}

export function normalizeTreeSelection(
  template: Template,
  selected: Iterable<TreeRef>,
  active?: TreeRef,
): TreeRef[] {
  const raw = [...selected];
  const effective = active && !raw.some((ref) => ref.kind === active.kind && ref.id === active.id)
    ? [active]
    : raw;
  const keys = new Set(effective.map(treeKey));
  const out: TreeRef[] = [];
  const visit = (containerId: string | null): void => {
    for (const entry of containerEntries(template, containerId)) {
      const ref: TreeRef = { kind: entry.kind, id: entry.id };
      if (keys.has(treeKey(ref)) && !hasSelectedAncestor(template, ref, keys)) out.push(ref);
      if (entry.kind === 'group') visit(entry.id);
    }
  };
  visit(null);
  return out;
}

function copyName(name: string): string {
  return `${name} copy`;
}

function offsetTransform(transform: Transform, offset: { x: number; y: number }): void {
  transform.x += offset.x;
  transform.y += offset.y;
}

export function cloneTreeSelection(
  template: Template,
  roots: TreeRef[],
  options: { createId: () => string; offset?: { x: number; y: number } },
): ClonedTree {
  const idMap: Record<string, string> = {};
  const assign = (ref: TreeRef): void => {
    idMap[ref.id] = options.createId();
    if (ref.kind === 'group') {
      for (const child of template.groupStacks[ref.id] ?? []) assign(child);
    }
  };
  for (const root of roots) assign(root);

  const layers: Layer[] = [];
  const groups: LayerGroup[] = [];
  const groupStacks: Record<string, RootStackEntry[]> = {};
  const rootIds = new Set(roots.map((ref) => ref.id));

  for (const [oldId, newId] of Object.entries(idMap)) {
    const layer = template.layers.find((item) => item.id === oldId);
    if (layer) {
      const copy = structuredClone(layer);
      copy.id = newId;
      copy.name = copyName(layer.name);
      copy.groupId = layer.groupId && idMap[layer.groupId] ? idMap[layer.groupId] : layer.groupId;
      if (rootIds.has(oldId) && options.offset) offsetTransform(copy.transform, options.offset);
      if (copy.type === 'crawl') copy.crawlDirectorId = '';
      layers.push(copy);
      continue;
    }
    const group = template.groups.find((item) => item.id === oldId);
    if (!group) continue;
    const copy = structuredClone(group);
    copy.id = newId;
    copy.name = copyName(group.name);
    copy.parentId = group.parentId && idMap[group.parentId] ? idMap[group.parentId] : group.parentId;
    if (rootIds.has(oldId) && options.offset) offsetTransform(copy.transform, options.offset);
    groups.push(copy);
    groupStacks[newId] = (template.groupStacks[oldId] ?? []).map((entry) => ({
      kind: entry.kind,
      id: idMap[entry.id] ?? entry.id,
    }));
  }

  return {
    layers,
    groups,
    groupStacks,
    roots: roots.map((ref) => ({ kind: ref.kind, id: idMap[ref.id] ?? ref.id })),
    idMap,
  };
}

export function applyClonedTree(
  template: Template,
  cloned: ClonedTree,
  options?: { insert?: boolean },
): void {
  template.layers.push(...cloned.layers);
  template.groups.push(...cloned.groups);
  Object.assign(template.groupStacks, cloned.groupStacks);
  for (const layer of cloned.layers) {
    if (layer.type === 'crawl') {
      layer.crawlDirectorId = layer.crawlDirectorId || createId();
      attachCrawlTimeline(template, layer);
    }
  }
  for (const [oldId, newId] of Object.entries(cloned.idMap)) {
    const director = template.timeline.trackDirectors[oldId];
    if (director) template.timeline.trackDirectors[newId] = director;
    const propertyDirectors = template.timeline.propertyTrackDirectors?.[oldId];
    if (propertyDirectors) {
      template.timeline.propertyTrackDirectors ??= {};
      template.timeline.propertyTrackDirectors[newId] = { ...propertyDirectors };
    }
  }
  for (const keyframe of template.timeline.keyframes) {
    for (const [oldId, newId] of Object.entries(cloned.idMap)) {
      if (keyframe.layers[oldId]) keyframe.layers[newId] = structuredClone(keyframe.layers[oldId]);
      if (keyframe.groups[oldId]) keyframe.groups[newId] = structuredClone(keyframe.groups[oldId]);
    }
  }
  if (options?.insert === false) return;
  for (const root of cloned.roots) {
    if (root.kind === 'layer') {
      const layer = template.layers.find((item) => item.id === root.id);
      if (layer) layer.groupId = null;
    } else {
      const group = template.groups.find((item) => item.id === root.id);
      if (group) group.parentId = null;
    }
  }
  template.rootStack.push(...cloned.roots);
}

function removeEntries(template: Template, ids: Set<string>): void {
  template.rootStack = template.rootStack.filter((entry) => !ids.has(entry.id));
  for (const groupId of Object.keys(template.groupStacks)) {
    template.groupStacks[groupId] = template.groupStacks[groupId].filter((entry) => !ids.has(entry.id));
  }
}

function setParents(template: Template, entries: TreeRef[], containerId: string | null): void {
  for (const entry of entries) {
    if (entry.kind === 'layer') {
      const layer = template.layers.find((item) => item.id === entry.id);
      if (layer) layer.groupId = containerId;
    } else {
      const group = template.groups.find((item) => item.id === entry.id);
      if (group) group.parentId = containerId;
    }
  }
}

export function insertTreeEntries(
  template: Template,
  entries: TreeRef[],
  dest: TreeInsert,
): void {
  if (entries.length === 0) return;
  const ids = new Set(entries.map((entry) => entry.id));
  removeEntries(template, ids);
  if (dest.type === 'inside') {
    setParents(template, entries, dest.groupId);
    const current = containerEntries(template, dest.groupId);
    setContainerEntries(template, dest.groupId, [...current, ...entries]);
    return;
  }
  const over = parseTreeKey(dest.key);
  if (!over) return;
  const containerId = findTreeContainer(template, over.id);
  if (containerId === undefined) return;
  setParents(template, entries, containerId);
  const display = [...containerEntries(template, containerId)].reverse();
  const overIndex = display.findIndex((entry) => entry.id === over.id);
  const insertAt = overIndex < 0 ? display.length : overIndex + (dest.type === 'after' ? 1 : 0);
  display.splice(insertAt, 0, ...entries);
  setContainerEntries(template, containerId, display.reverse());
}

export function dropCopies(
  template: Template,
  selected: Iterable<TreeRef>,
  active: TreeRef,
  dest: TreeInsert,
  createId: () => string,
  reparent?: (template: Template, ref: TreeRef, parentId: string | null) => void,
): TreeRef[] {
  const roots = normalizeTreeSelection(template, selected, active);
  if (roots.length === 0) return [];
  const cloned = cloneTreeSelection(template, roots, { createId });
  applyClonedTree(template, cloned, { insert: false });
  const destParent = dest.type === 'inside' ? dest.groupId : findTreeContainer(template, parseTreeKey(dest.key)?.id ?? '');
  if (reparent && destParent !== undefined) {
    for (const root of cloned.roots) reparent(template, root, destParent);
  }
  insertTreeEntries(template, cloned.roots, dest);
  return cloned.roots;
}
