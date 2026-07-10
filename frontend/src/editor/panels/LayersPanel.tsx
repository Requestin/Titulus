// frontend/src/editor/panels/LayersPanel.tsx
//
// Layer tree: top-level stack + groups (expandable), reorder within a container
// via @dnd-kit, visibility/lock/select/rename/delete, add layer, new group.
// Ctrl/Cmd + drag copies the dragged entries (deep, with timeline tracks).
// Display is reversed so the frontmost layer (last in stack) sits on top.

import { useEffect, useRef, useState, type ComponentType } from 'react';
import {
  DndContext, PointerSensor, useSensor, useSensors, closestCenter, pointerWithin, useDroppable,
  type CollisionDetection, type DragEndEvent, type DragMoveEvent, type DragOverEvent,
} from '@dnd-kit/core';
import {
  SortableContext, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Type, Square, Image as ImageIcon, Video, Clock, Folder,
  Eye, EyeOff, Lock, Unlock, GripVertical, ChevronRight, ChevronDown,
  Plus, FolderPlus, CheckSquare, Trash2,
} from 'lucide-react';
import type { LayerType, RootStackEntry, Template } from '@runtime';
import { createId } from '@/core/id';
import { useEditor } from '../store';
import { reparentEntriesIntoGroup } from '../groupBounds';
import { LAYER_TYPES, LAYER_LABEL } from '../factories';
import { cn } from '@/lib/cn';

const LAYER_ICON: Record<LayerType, ComponentType<{ className?: string }>> = {
  text: Type, rect: Square, image: ImageIcon, video: Video, clock: Clock, mask: MaskIcon,
};

type EntryKey = `${RootStackEntry['kind']}:${string}`;
type ContainerId = string | null;
type DragIntent =
  | { type: 'inside'; groupId: string }
  | { type: 'before' | 'after'; key: EntryKey }
  | { type: 'container-before' | 'container-after'; containerId: ContainerId }
  | null;

function containerDropId(containerId: ContainerId, edge: 'start' | 'end'): string {
  return `container:${containerId ?? 'root'}:${edge}`;
}

function parseContainerDropId(id: string): { containerId: ContainerId; edge: 'start' | 'end' } | null {
  const match = /^container:(.+):(start|end)$/.exec(id);
  if (!match) return null;
  const containerId = match[1] === 'root' ? null : match[1];
  return { containerId, edge: match[2] as 'start' | 'end' };
}

function entryKey(entry: RootStackEntry): EntryKey {
  return `${entry.kind}:${entry.id}`;
}

function parseEntryKey(key: string): RootStackEntry | null {
  const [kind, id] = key.split(':');
  if ((kind !== 'layer' && kind !== 'group') || !id) return null;
  return { kind, id };
}

function containerEntries(t: Template, containerId: string | null): RootStackEntry[] {
  return containerId === null ? t.rootStack : (t.groupStacks[containerId] ?? []);
}

function setContainerEntries(t: Template, containerId: string | null, entries: RootStackEntry[]): void {
  if (containerId === null) t.rootStack = entries;
  else t.groupStacks[containerId] = entries;
}

function findContainer(t: Template, key: EntryKey): string | null | undefined {
  if (t.rootStack.some((e) => entryKey(e) === key)) return null;
  for (const [groupId, entries] of Object.entries(t.groupStacks)) {
    if (entries.some((e) => entryKey(e) === key)) return groupId;
  }
  return undefined;
}

function collectDisplayEntries(t: Template, containerId: string | null = null, out: RootStackEntry[] = []): RootStackEntry[] {
  for (const entry of [...containerEntries(t, containerId)].reverse()) {
    out.push(entry);
    if (entry.kind === 'group') collectDisplayEntries(t, entry.id, out);
  }
  return out;
}

function selectedHasAncestor(t: Template, entry: RootStackEntry, selected: Set<EntryKey>): boolean {
  let parentId = entry.kind === 'layer'
    ? t.layers.find((l) => l.id === entry.id)?.groupId ?? null
    : t.groups.find((g) => g.id === entry.id)?.parentId ?? null;
  while (parentId) {
    if (selected.has(`group:${parentId}`)) return true;
    parentId = t.groups.find((g) => g.id === parentId)?.parentId ?? null;
  }
  return false;
}

function normalizedMoveKeys(t: Template, keys: Set<EntryKey>, activeKey: EntryKey): Set<EntryKey> {
  const raw = keys.has(activeKey) ? keys : new Set<EntryKey>([activeKey]);
  const next = new Set<EntryKey>();
  for (const entry of collectDisplayEntries(t)) {
    const key = entryKey(entry);
    if (raw.has(key) && !selectedHasAncestor(t, entry, raw)) next.add(key);
  }
  return next;
}

function wouldCreateCycle(t: Template, moving: RootStackEntry[], targetContainerId: string | null): boolean {
  if (!targetContainerId) return false;
  const movingGroups = new Set(moving.filter((e) => e.kind === 'group').map((e) => e.id));
  let cursor: string | null = targetContainerId;
  while (cursor) {
    if (movingGroups.has(cursor)) return true;
    cursor = t.groups.find((g) => g.id === cursor)?.parentId ?? null;
  }
  return false;
}

function removeMovingEntries(t: Template, keys: Set<EntryKey>): void {
  setContainerEntries(t, null, t.rootStack.filter((e) => !keys.has(entryKey(e))));
  for (const [groupId, entries] of Object.entries(t.groupStacks)) {
    t.groupStacks[groupId] = entries.filter((e) => !keys.has(entryKey(e)));
  }
}

function updateParents(t: Template, entries: RootStackEntry[], targetContainerId: string | null): void {
  for (const entry of entries) {
    if (entry.kind === 'layer') {
      const layer = t.layers.find((l) => l.id === entry.id);
      if (layer) layer.groupId = targetContainerId;
    } else {
      const group = t.groups.find((g) => g.id === entry.id);
      if (group) group.parentId = targetContainerId;
    }
  }
}

function affectedGroupContainers(t: Template, keys: Set<EntryKey>): Set<string> {
  const out = new Set<string>();
  for (const key of keys) {
    const entry = parseEntryKey(key);
    if (!entry) continue;
    const container = findContainer(t, key);
    if (container) out.add(container);
  }
  return out;
}

function moveEntriesToGroup(t: Template, keys: Set<EntryKey>, targetContainerId: string | null): void {
  const moving = collectDisplayEntries(t).filter((e) => keys.has(entryKey(e)));
  if (moving.length === 0 || wouldCreateCycle(t, moving, targetContainerId)) return;
  const prevGroups = affectedGroupContainers(t, keys);
  removeMovingEntries(t, keys);
  updateParents(t, moving, targetContainerId);
  const currentDisplay = [...containerEntries(t, targetContainerId)].reverse();
  setContainerEntries(t, targetContainerId, [...moving, ...currentDisplay].reverse());
  if (targetContainerId) {
    reparentEntriesIntoGroup(t, targetContainerId, moving);
  }
  for (const gid of prevGroups) {
    if (gid !== targetContainerId) {
      const g = t.groups.find((x) => x.id === gid);
      if (g) {
        g.transform.width = 0;
        g.transform.height = 0;
      }
    }
  }
}

function moveEntriesToContainerEdge(
  t: Template,
  keys: Set<EntryKey>,
  targetContainerId: ContainerId,
  edge: 'start' | 'end',
): void {
  const moving = collectDisplayEntries(t).filter((e) => keys.has(entryKey(e)));
  if (moving.length === 0 || wouldCreateCycle(t, moving, targetContainerId)) return;
  const prevGroups = affectedGroupContainers(t, keys);
  removeMovingEntries(t, keys);
  updateParents(t, moving, targetContainerId);
  const currentDisplay = [...containerEntries(t, targetContainerId)].reverse();
  if (edge === 'start') currentDisplay.unshift(...moving);
  else currentDisplay.push(...moving);
  setContainerEntries(t, targetContainerId, currentDisplay.reverse());
  if (targetContainerId) reparentEntriesIntoGroup(t, targetContainerId, moving);
  for (const gid of prevGroups) {
    if (gid !== targetContainerId) {
      const g = t.groups.find((x) => x.id === gid);
      if (g) {
        g.transform.width = 0;
        g.transform.height = 0;
      }
    }
  }
}

function moveEntriesNear(t: Template, keys: Set<EntryKey>, overKey: EntryKey, position: 'before' | 'after'): void {
  if (keys.has(overKey)) return;
  const targetContainerId = findContainer(t, overKey);
  if (targetContainerId === undefined) return;
  const moving = collectDisplayEntries(t).filter((e) => keys.has(entryKey(e)));
  if (moving.length === 0 || wouldCreateCycle(t, moving, targetContainerId)) return;
  const prevGroups = affectedGroupContainers(t, keys);
  const oldContainers = new Map<EntryKey, string | null>();
  for (const entry of moving) {
    const key = entryKey(entry);
    const container = findContainer(t, key);
    oldContainers.set(key, container === undefined ? null : container);
  }
  removeMovingEntries(t, keys);
  updateParents(t, moving, targetContainerId);
  const currentDisplay = [...containerEntries(t, targetContainerId)].reverse();
  const overIndex = currentDisplay.findIndex((e) => entryKey(e) === overKey);
  const insertAt = overIndex < 0 ? currentDisplay.length : overIndex + (position === 'after' ? 1 : 0);
  currentDisplay.splice(insertAt, 0, ...moving);
  setContainerEntries(t, targetContainerId, currentDisplay.reverse());

  const containerChanged = moving.some((e) => oldContainers.get(entryKey(e)) !== targetContainerId);
  if (containerChanged && targetContainerId) {
    reparentEntriesIntoGroup(t, targetContainerId, moving);
  }

  for (const gid of prevGroups) {
    if (gid !== targetContainerId) {
      const g = t.groups.find((x) => x.id === gid);
      if (g) {
        g.transform.width = 0;
        g.transform.height = 0;
      }
    }
  }
}

/**
 * Deep-clone one stack entry: a layer, or a group with its whole subtree
 * (nested groups/layers get fresh ids, parent pointers rewired to the clones).
 * Every oldId -> newId pair is recorded in idMap for timeline duplication.
 */
function cloneEntryDeep(t: Template, entry: RootStackEntry, idMap: Map<string, string>): RootStackEntry | null {
  if (entry.kind === 'layer') {
    const src = t.layers.find((l) => l.id === entry.id);
    if (!src) return null;
    const copy = structuredClone(src);
    copy.id = createId();
    idMap.set(src.id, copy.id);
    t.layers.push(copy);
    return { kind: 'layer', id: copy.id };
  }
  const srcGroup = t.groups.find((g) => g.id === entry.id);
  if (!srcGroup) return null;
  const copy = structuredClone(srcGroup);
  copy.id = createId();
  idMap.set(srcGroup.id, copy.id);
  t.groups.push(copy);
  const childStack: RootStackEntry[] = [];
  for (const child of t.groupStacks[srcGroup.id] ?? []) {
    const clonedChild = cloneEntryDeep(t, child, idMap);
    if (!clonedChild) continue;
    if (clonedChild.kind === 'layer') {
      const l = t.layers.find((x) => x.id === clonedChild.id);
      if (l) l.groupId = copy.id;
    } else {
      const g = t.groups.find((x) => x.id === clonedChild.id);
      if (g) g.parentId = copy.id;
    }
    childStack.push(clonedChild);
  }
  t.groupStacks[copy.id] = childStack;
  return { kind: 'group', id: copy.id };
}

/**
 * Duplicate timeline data for cloned targets: track -> director assignment is
 * kept identical to the source (same director), keyframe values are copied
 * per frame, so the copy animates exactly like the original.
 */
function copyTimelineTracks(t: Template, idMap: Map<string, string>): void {
  for (const [oldId, newId] of idMap) {
    const directorId = t.timeline.trackDirectors[oldId];
    if (directorId) t.timeline.trackDirectors[newId] = directorId;
    for (const [key, did] of Object.entries(t.timeline.trackDirectors)) {
      if (!key.includes(`:${oldId}:`)) continue;
      const nextKey = key.replace(`:${oldId}:`, `:${newId}:`);
      t.timeline.trackDirectors[nextKey] = did;
    }
  }
  for (const kf of t.timeline.keyframes) {
    for (const [oldId, newId] of idMap) {
      if (kf.layers[oldId]) kf.layers[newId] = structuredClone(kf.layers[oldId]);
      if (kf.groups[oldId]) kf.groups[newId] = structuredClone(kf.groups[oldId]);
    }
  }
}

/**
 * Copy the given (normalized top-level) entries in place: each clone is
 * inserted next to its original in the same container, keeping transforms
 * valid. Returns the keys of the top-level clones (ready to be moved to the
 * drop target with the regular move helpers).
 */
function copyEntries(t: Template, keys: Set<EntryKey>): Set<EntryKey> {
  const idMap = new Map<string, string>();
  const newKeys = new Set<EntryKey>();
  const containerIds: (string | null)[] = [null, ...Object.keys(t.groupStacks)];
  for (const containerId of containerIds) {
    const entries = containerEntries(t, containerId);
    if (!entries.some((e) => keys.has(entryKey(e)))) continue;
    const next: RootStackEntry[] = [];
    for (const e of entries) {
      next.push(e);
      if (!keys.has(entryKey(e))) continue;
      const cloned = cloneEntryDeep(t, e, idMap);
      if (!cloned) continue;
      const obj = cloned.kind === 'layer'
        ? t.layers.find((l) => l.id === cloned.id)
        : t.groups.find((g) => g.id === cloned.id);
      if (obj) obj.name = `${obj.name} copy`;
      next.push(cloned);
      newKeys.add(entryKey(cloned));
    }
    setContainerEntries(t, containerId, next);
  }
  copyTimelineTracks(t, idMap);
  return newKeys;
}

function activeCenter(event: DragMoveEvent | DragOverEvent | DragEndEvent): { x: number; y: number } | null {
  const rect = event.active.rect.current.translated ?? event.active.rect.current.initial;
  if (!rect) return null;
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

const layerTreeCollision: CollisionDetection = (args) => {
  const pointerHits = pointerWithin(args);
  const containerHits = pointerHits.filter((c) => String(c.id).startsWith('container:'));
  if (containerHits.length > 0) return containerHits;
  return closestCenter(args);
};

function computeDragIntent(event: DragMoveEvent | DragOverEvent | DragEndEvent): DragIntent {
  if (!event.over) return null;
  const overId = String(event.over.id);

  const containerDrop = parseContainerDropId(overId);
  if (containerDrop) {
    return containerDrop.edge === 'start'
      ? { type: 'container-before', containerId: containerDrop.containerId }
      : { type: 'container-after', containerId: containerDrop.containerId };
  }

  const overEntry = parseEntryKey(overId);
  if (!overEntry) return null;
  const center = activeCenter(event);
  const rect = event.over.rect;
  if (!center || !rect) return { type: 'after', key: entryKey(overEntry) };

  if (overEntry.kind === 'group') {
    const localX = center.x - rect.left;
    const insideBand = rect.width * 0.38;
    if (localX >= insideBand) {
      return { type: 'inside', groupId: overEntry.id };
    }
  }

  return {
    type: center.y < rect.top + rect.height / 2 ? 'before' : 'after',
    key: entryKey(overEntry),
  };
}

/** Square outline with «M» — same footprint as lucide Square (h-4 w-4). */
function MaskIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="2" width="12" height="12" rx="1" />
      <text x="8" y="11.5" textAnchor="middle" fontSize="7" fontWeight="700" fill="currentColor" stroke="none">M</text>
    </svg>
  );
}

export function LayersPanel() {
  const template = useEditor((s) => s.template);
  const addLayer = useEditor((s) => s.addLayer);
  const addGroup = useEditor((s) => s.addGroup);
  const patch = useEditor((s) => s.patch);
  const select = useEditor((s) => s.select);
  const [addOpen, setAddOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<EntryKey>>(() => new Set());
  const [dragIntent, setDragIntent] = useState<DragIntent>(null);
  // Ctrl/Cmd held -> drag copies instead of moving. Tracked via keyboard +
  // pointermove (dnd-kit drag events don't carry live modifier state).
  const copyKeyRef = useRef(false);
  const [copyHint, setCopyHint] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  useEffect(() => {
    function sync(e: KeyboardEvent | PointerEvent) {
      const held = e.ctrlKey || e.metaKey;
      if (copyKeyRef.current === held) return;
      copyKeyRef.current = held;
      setCopyHint(held);
    }
    window.addEventListener('keydown', sync);
    window.addEventListener('keyup', sync);
    window.addEventListener('pointermove', sync);
    return () => {
      window.removeEventListener('keydown', sync);
      window.removeEventListener('keyup', sync);
      window.removeEventListener('pointermove', sync);
    };
  }, []);

  if (!template) return null;

  function toggleSelectMode() {
    setSelectMode((v) => {
      if (v) setSelectedKeys(new Set());
      return !v;
    });
  }

  function toggleEntry(key: EntryKey) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function updateDragIntent(e: DragMoveEvent | DragOverEvent) {
    setDragIntent(computeDragIntent(e));
  }

  function onDragOver(e: DragOverEvent) {
    updateDragIntent(e);
  }

  function onDragEnd(e: DragEndEvent) {
    const intent = computeDragIntent(e) ?? dragIntent;
    setDragIntent(null);
    const activeKey = String(e.active.id) as EntryKey;
    const activeEntry = parseEntryKey(activeKey);
    if (!activeEntry || !intent) return;
    const isCopy = copyKeyRef.current;
    let copiedKeys: Set<EntryKey> | null = null;
    patch((t) => {
      let keys = normalizedMoveKeys(t, selectedKeys, activeKey);
      if (isCopy) {
        keys = copyEntries(t, keys);
        copiedKeys = keys;
      }
      if (intent.type === 'inside') {
        if (!keys.has(`group:${intent.groupId}`)) moveEntriesToGroup(t, keys, intent.groupId);
      } else if (intent.type === 'container-before') {
        moveEntriesToContainerEdge(t, keys, intent.containerId, 'start');
      } else if (intent.type === 'container-after') {
        moveEntriesToContainerEdge(t, keys, intent.containerId, 'end');
      } else if (intent.type === 'before' || intent.type === 'after') {
        moveEntriesNear(t, keys, intent.key, intent.type);
      }
    });
    if (copiedKeys) {
      const first = [...(copiedKeys as Set<EntryKey>)][0];
      const firstEntry = first ? parseEntryKey(first) : null;
      if (firstEntry) select({ kind: firstEntry.kind, id: firstEntry.id });
    }
  }

  function onDragCancel() {
    setDragIntent(null);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={layerTreeCollision}
      onDragMove={updateDragIntent}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-[12px] font-semibold text-ink-muted">Layers</span>
        <div className="relative flex items-center gap-1">
          <button
            onClick={toggleSelectMode}
            title="Select"
            aria-pressed={selectMode}
            className={cn(
              'grid h-7 w-7 place-items-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink',
              selectMode && 'bg-primary/15 text-primary',
            )}
          >
            <CheckSquare className="h-4 w-4" aria-hidden />
          </button>
          <button
            onClick={addGroup}
            title="New group"
            className="grid h-7 w-7 place-items-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            <FolderPlus className="h-4 w-4" aria-hidden />
          </button>
          <button
            onClick={() => setAddOpen((v) => !v)}
            title="Add layer"
            className="grid h-7 w-7 place-items-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            <Plus className="h-4 w-4" aria-hidden />
          </button>
          {addOpen && (
            <>
              <div className="fixed inset-0 z-dropdown" onClick={() => setAddOpen(false)} />
              <div className="absolute right-0 top-8 z-dropdown w-40 overflow-hidden rounded-md border border-border bg-surface-2 py-1 shadow-xl">
                {LAYER_TYPES.map((type) => {
                  const Icon = LAYER_ICON[type];
                  return (
                    <button
                      key={type}
                      onClick={() => { addLayer(type); setAddOpen(false); }}
                      className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-ink hover:bg-surface"
                    >
                      <Icon className="h-4 w-4 text-ink-muted" aria-hidden />
                      {LAYER_LABEL[type]}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        <Container
          entries={template.rootStack}
          containerId={null}
          depth={0}
          selectMode={selectMode}
          selectedKeys={selectedKeys}
          onToggleEntry={toggleEntry}
          dragIntent={dragIntent}
          copyHint={copyHint}
        />
        {template.rootStack.length === 0 && (
          <p className="px-3 py-6 text-center text-[12px] text-ink-faint">
            No layers. Use + to add one.
          </p>
        )}
      </div>
      </div>
    </DndContext>
  );
}

function Container({
  entries,
  containerId,
  depth,
  selectMode,
  selectedKeys,
  onToggleEntry,
  dragIntent,
  copyHint,
}: {
  entries: RootStackEntry[];
  containerId: ContainerId;
  depth: number;
  selectMode: boolean;
  selectedKeys: Set<EntryKey>;
  onToggleEntry: (key: EntryKey) => void;
  dragIntent: DragIntent;
  copyHint: boolean;
}) {
  // Reversed so frontmost (last in stack) shows on top.
  const display = [...entries].reverse();
  const ids = display.map((e) => entryKey(e));
  const startActive = dragIntent?.type === 'container-before' && dragIntent.containerId === containerId;
  const endActive = dragIntent?.type === 'container-after' && dragIntent.containerId === containerId;

  return (
    <SortableContext items={ids} strategy={verticalListSortingStrategy}>
      <ContainerDropPad
        id={containerDropId(containerId, 'start')}
        depth={depth}
        active={startActive}
        copy={copyHint}
        position="before"
      />
      {display.map((entry) => (
        <Row
          key={`${entry.kind}:${entry.id}`}
          entry={entry}
          depth={depth}
          selectMode={selectMode}
          selectedKeys={selectedKeys}
          onToggleEntry={onToggleEntry}
          dragIntent={dragIntent}
          copyHint={copyHint}
        />
      ))}
      <ContainerDropPad
        id={containerDropId(containerId, 'end')}
        depth={depth}
        active={endActive}
        copy={copyHint}
        position="after"
      />
    </SortableContext>
  );
}

function ContainerDropPad({
  id,
  depth,
  active,
  copy,
  position,
}: {
  id: string;
  depth: number;
  active: boolean;
  copy: boolean;
  position: 'before' | 'after';
}) {
  const { setNodeRef } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className="relative -my-0.5 h-3 shrink-0">
      {active && <DropLine position={position} depth={depth} copy={copy} />}
    </div>
  );
}

function Row({
  entry,
  depth,
  selectMode,
  selectedKeys,
  onToggleEntry,
  dragIntent,
  copyHint,
}: {
  entry: RootStackEntry;
  depth: number;
  selectMode: boolean;
  selectedKeys: Set<EntryKey>;
  onToggleEntry: (key: EntryKey) => void;
  dragIntent: DragIntent;
  copyHint: boolean;
}) {
  const template = useEditor((s) => s.template)!;
  const selection = useEditor((s) => s.selection);
  const select = useEditor((s) => s.select);
  const toggleVisible = useEditor((s) => s.toggleVisible);
  const toggleLock = useEditor((s) => s.toggleLock);
  const deleteEntry = useEditor((s) => s.deleteEntry);
  const updateLayer = useEditor((s) => s.updateLayer);
  const patch = useEditor((s) => s.patch);
  const [expanded, setExpanded] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const key = entryKey(entry);
  const isLayer = entry.kind === 'layer';

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: key,
  });

  const obj = isLayer
    ? template.layers.find((l) => l.id === entry.id)
    : template.groups.find((g) => g.id === entry.id);
  if (!obj) return null;

  const selected = selection?.kind === entry.kind && selection.id === entry.id;
  const checked = selectedKeys.has(key);
  const groupDropActive = !isLayer && dragIntent?.type === 'inside' && dragIntent.groupId === entry.id;
  const lineBefore = dragIntent?.type === 'before' && dragIntent.key === key;
  const lineAfter = dragIntent?.type === 'after' && dragIntent.key === key;
  const Icon = isLayer ? LAYER_ICON[(obj as { type: LayerType }).type] : Folder;
  const children = !isLayer ? (template.groupStacks[entry.id] ?? []) : [];

  function rename(name: string) {
    if (isLayer) updateLayer(entry.id, (l) => { l.name = name; });
    else patch((t) => { const g = t.groups.find((x) => x.id === entry.id); if (g) g.name = name; });
  }

  return (
    <div ref={setNodeRef} className="relative" style={{ transform: CSS.Transform.toString(transform), transition }}>
      {lineBefore && <DropLine position="before" depth={depth} copy={copyHint} />}
      <div
        onClick={() => select({ kind: entry.kind, id: entry.id })}
        className={cn(
          'group flex h-8 items-center gap-1 pr-2 text-[13px] transition-colors',
          selected ? 'bg-primary/15 text-ink' : 'text-ink-muted hover:bg-surface-2',
          checked && 'bg-info/10 text-ink',
          groupDropActive && !copyHint && 'bg-warning/25 text-ink ring-1 ring-inset ring-warning/80',
          groupDropActive && copyHint && 'bg-success/25 text-ink ring-1 ring-inset ring-success/80',
          isDragging && 'opacity-60',
        )}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        {selectMode && (
          <input
            type="checkbox"
            checked={checked}
            onChange={() => onToggleEntry(key)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select ${obj.name}`}
            className="h-3.5 w-3.5 shrink-0 accent-primary"
          />
        )}

        <button
          {...attributes}
          {...listeners}
          className={cn(
            'grid h-5 w-4 cursor-grab place-items-center text-ink-faint opacity-0 group-hover:opacity-100',
            checked && 'opacity-100 text-primary',
          )}
          aria-label={checked ? 'Drag selected items' : 'Drag to reorder'}
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="h-3.5 w-3.5" aria-hidden />
        </button>

        {!isLayer ? (
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
            className="grid h-5 w-4 place-items-center text-ink-faint"
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        ) : (
          <span className="w-4" />
        )}

        <div
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 rounded px-0.5 py-0.5',
            !isLayer && 'transition-colors',
            groupDropActive && (copyHint ? 'bg-success/25' : 'bg-warning/25'),
          )}
        >
          <Icon className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />

          {renaming ? (
            <input
              autoFocus
              defaultValue={obj.name}
              onBlur={(e) => { rename(e.target.value.trim() || obj.name); setRenaming(false); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setRenaming(false);
              }}
              onClick={(e) => e.stopPropagation()}
              className="min-w-0 flex-1 rounded border border-ring bg-surface px-1 text-[13px] text-ink focus-visible:outline-none"
            />
          ) : (
            <span
              onDoubleClick={(e) => { e.stopPropagation(); setRenaming(true); }}
              className="min-w-0 flex-1 truncate"
            >
              {obj.name}
            </span>
          )}
        </div>

        <button
          onClick={(e) => {
            e.stopPropagation();
            select({ kind: entry.kind, id: entry.id });
            deleteEntry(entry.kind, entry.id);
          }}
          className="grid h-6 w-6 place-items-center text-ink-faint opacity-0 hover:text-live group-hover:opacity-100"
          aria-label={`Delete ${obj.name}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); toggleLock(entry.kind, entry.id); }}
          className={cn('grid h-6 w-6 place-items-center hover:text-ink', obj.locked ? 'text-ink-muted' : 'text-ink-faint opacity-0 group-hover:opacity-100')}
          aria-label={obj.locked ? 'Unlock' : 'Lock'}
        >
          {obj.locked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); toggleVisible(entry.kind, entry.id); }}
          className={cn('grid h-6 w-6 place-items-center hover:text-ink', obj.visible ? 'text-ink-faint opacity-0 group-hover:opacity-100' : 'text-ink-muted')}
          aria-label={obj.visible ? 'Hide' : 'Show'}
        >
          {obj.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        </button>
      </div>

      {!isLayer && expanded && (
        <Container
          entries={children}
          containerId={entry.id}
          depth={depth + 1}
          selectMode={selectMode}
          selectedKeys={selectedKeys}
          onToggleEntry={onToggleEntry}
          dragIntent={dragIntent}
          copyHint={copyHint}
        />
      )}
      {lineAfter && <DropLine position="after" depth={depth} copy={copyHint} />}
    </div>
  );
}

function DropLine({ position, depth, copy }: { position: 'before' | 'after'; depth: number; copy?: boolean }) {
  return (
    <div
      className={cn(
        'pointer-events-none absolute left-2 right-2 z-sticky h-0.5 rounded-full',
        copy
          ? 'bg-success shadow-[0_0_0_1px_oklch(var(--success)/0.18)]'
          : 'bg-primary shadow-[0_0_0_1px_oklch(var(--primary)/0.18)]',
        position === 'before' ? 'top-0' : 'bottom-0',
      )}
      style={{ marginLeft: 8 + depth * 14 }}
      aria-hidden
    />
  );
}
