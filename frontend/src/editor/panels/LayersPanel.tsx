// frontend/src/editor/panels/LayersPanel.tsx
//
// Layer tree: top-level stack + groups (expandable), reorder within a container
// via @dnd-kit, visibility/lock/select/rename/delete, add layer, new group.
// Display is reversed so the frontmost layer (last in stack) sits on top.

import { useEffect, useRef, useState, type ComponentType } from 'react';
import {
  DndContext, PointerSensor, useSensor, useSensors, closestCenter,
  type DragEndEvent, type DragMoveEvent, type DragOverEvent,
} from '@dnd-kit/core';
import {
  SortableContext, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Type, Square, Image as ImageIcon, Video, Clock, Folder, WrapText,
  Eye, EyeOff, Lock, Unlock, GripVertical, ChevronRight, ChevronDown,
  Plus, FolderPlus, CheckSquare, Trash2,
} from 'lucide-react';
import type { LayerType, RootStackEntry, Template } from '@runtime';
import { reparentTargetAtPlayhead, useEditor } from '../store';
import { dropCopies, parseTreeKey, type TreeInsert } from '../treeClipboard';
import { createId } from '@/core/id';
import { LAYER_TYPES, LAYER_LABEL } from '../factories';
import { cn } from '@/lib/cn';

const LAYER_ICON: Record<LayerType, ComponentType<{ className?: string }>> = {
  text: Type, rect: Square, image: ImageIcon, video: Video, clock: Clock, mask: MaskIcon, crawl: WrapText,
};

function iconForLayer(type: string): ComponentType<{ className?: string }> {
  return LAYER_ICON[type as LayerType] ?? Square;
}

type EntryKey = `${RootStackEntry['kind']}:${string}`;
type DragIntent =
  | { type: 'inside'; groupId: string }
  | { type: 'before' | 'after'; key: EntryKey }
  | null;

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
  const { playhead, activeDirectorId } = useEditor.getState();
  for (const entry of entries) {
    if (entry.kind === 'layer') {
      const layer = t.layers.find((l) => l.id === entry.id);
      if (layer) {
        reparentTargetAtPlayhead(t, entry, targetContainerId, playhead, activeDirectorId);
        layer.groupId = targetContainerId;
      }
    } else {
      const group = t.groups.find((g) => g.id === entry.id);
      if (group) {
        reparentTargetAtPlayhead(t, entry, targetContainerId, playhead, activeDirectorId);
        group.parentId = targetContainerId;
      }
    }
  }
}

function moveEntriesToGroup(t: Template, keys: Set<EntryKey>, targetContainerId: string | null): void {
  const moving = collectDisplayEntries(t).filter((e) => keys.has(entryKey(e)));
  if (moving.length === 0 || wouldCreateCycle(t, moving, targetContainerId)) return;
  removeMovingEntries(t, keys);
  updateParents(t, moving, targetContainerId);
  const currentDisplay = [...containerEntries(t, targetContainerId)].reverse();
  setContainerEntries(t, targetContainerId, [...moving, ...currentDisplay].reverse());
}

function moveEntriesNear(t: Template, keys: Set<EntryKey>, overKey: EntryKey, position: 'before' | 'after'): void {
  if (keys.has(overKey)) return;
  const targetContainerId = findContainer(t, overKey);
  if (targetContainerId === undefined) return;
  const moving = collectDisplayEntries(t).filter((e) => keys.has(entryKey(e)));
  if (moving.length === 0 || wouldCreateCycle(t, moving, targetContainerId)) return;
  removeMovingEntries(t, keys);
  updateParents(t, moving, targetContainerId);
  const currentDisplay = [...containerEntries(t, targetContainerId)].reverse();
  const overIndex = currentDisplay.findIndex((e) => entryKey(e) === overKey);
  const insertAt = overIndex < 0 ? currentDisplay.length : overIndex + (position === 'after' ? 1 : 0);
  currentDisplay.splice(insertAt, 0, ...moving);
  setContainerEntries(t, targetContainerId, currentDisplay.reverse());
}

function activeCenter(event: DragMoveEvent | DragOverEvent | DragEndEvent): { x: number; y: number } | null {
  const rect = event.active.rect.current.translated ?? event.active.rect.current.initial;
  if (!rect) return null;
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function computeDragIntent(event: DragMoveEvent | DragOverEvent | DragEndEvent): DragIntent {
  if (!event.over) return null;
  const overEntry = parseEntryKey(String(event.over.id));
  if (!overEntry) return null;
  const center = activeCenter(event);
  const rect = event.over.rect;
  if (!center || !rect) return { type: 'after', key: entryKey(overEntry) };

  if (overEntry.kind === 'group' && center.x >= rect.left + rect.width * 0.55) {
    return { type: 'inside', groupId: overEntry.id };
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
  const checked = useEditor((s) => s.checked);
  const toggleChecked = useEditor((s) => s.toggleChecked);
  const clearChecked = useEditor((s) => s.clearChecked);
  const [addOpen, setAddOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [dragIntent, setDragIntent] = useState<DragIntent>(null);
  const copyHeld = useRef(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const selectedKeys = new Set(checked.map((item) => `${item.kind}:${item.id}` as EntryKey));
  useEffect(() => {
    const sync = (event: KeyboardEvent | PointerEvent) => {
      copyHeld.current = event.ctrlKey || event.metaKey;
    };
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
      if (v) clearChecked();
      return !v;
    });
  }

  function toggleEntry(key: EntryKey) {
    const ref = parseTreeKey(key);
    if (ref) toggleChecked(ref);
  }

  function updateDragIntent(e: DragMoveEvent | DragOverEvent) {
    setDragIntent(computeDragIntent(e));
  }

  function onDragOver(e: DragOverEvent) {
    updateDragIntent(e);
  }

  function onDragEnd(e: DragEndEvent) {
    const intent = computeDragIntent(e) ?? dragIntent;
    const copy = copyHeld.current;
    setDragIntent(null);
    const activeKey = String(e.active.id) as EntryKey;
    const activeEntry = parseEntryKey(activeKey);
    if (!activeEntry || !intent) return;
    const dest: TreeInsert = intent.type === 'inside'
      ? { type: 'inside', groupId: intent.groupId }
      : { type: intent.type, key: intent.key };
    patch((t) => {
      if (copy) {
        dropCopies(
          t,
          useEditor.getState().checked,
          activeEntry,
          dest,
          createId,
          (doc, ref, parentId) => {
            reparentTargetAtPlayhead(doc, ref, parentId, useEditor.getState().playhead, useEditor.getState().activeDirectorId);
          },
        );
        return;
      }
      const keys = normalizedMoveKeys(t, selectedKeys, activeKey);
      if (intent.type === 'inside') {
        if (!keys.has(`group:${intent.groupId}`)) moveEntriesToGroup(t, keys, intent.groupId);
      } else {
        moveEntriesNear(t, keys, intent.key, intent.type);
      }
    });
  }

  function onDragCancel() {
    setDragIntent(null);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragMove={updateDragIntent}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-[12px] font-semibold text-ink-muted">Tree</span>
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
                  const Icon = iconForLayer(type);
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

      <div
        className="min-h-0 flex-1 overflow-auto py-1"
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) select(null);
        }}
      >
        <Container
          entries={template.rootStack}
          depth={0}
          selectMode={selectMode}
          selectedKeys={selectedKeys}
          onToggleEntry={toggleEntry}
          dragIntent={dragIntent}
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
  depth,
  selectMode,
  selectedKeys,
  onToggleEntry,
  dragIntent,
}: {
  entries: RootStackEntry[];
  depth: number;
  selectMode: boolean;
  selectedKeys: Set<EntryKey>;
  onToggleEntry: (key: EntryKey) => void;
  dragIntent: DragIntent;
}) {
  // Reversed so frontmost (last in stack) shows on top.
  const display = [...entries].reverse();
  const ids = display.map((e) => entryKey(e));

  return (
    <SortableContext items={ids} strategy={verticalListSortingStrategy}>
      {display.map((entry) => (
        <Row
          key={`${entry.kind}:${entry.id}`}
          entry={entry}
          depth={depth}
          selectMode={selectMode}
          selectedKeys={selectedKeys}
          onToggleEntry={onToggleEntry}
          dragIntent={dragIntent}
        />
      ))}
    </SortableContext>
  );
}

function Row({
  entry,
  depth,
  selectMode,
  selectedKeys,
  onToggleEntry,
  dragIntent,
}: {
  entry: RootStackEntry;
  depth: number;
  selectMode: boolean;
  selectedKeys: Set<EntryKey>;
  onToggleEntry: (key: EntryKey) => void;
  dragIntent: DragIntent;
}) {
  const template = useEditor((s) => s.template)!;
  const selection = useEditor((s) => s.selection);
  const select = useEditor((s) => s.select);
  const deleteSelected = useEditor((s) => s.deleteSelected);
  const toggleVisible = useEditor((s) => s.toggleVisible);
  const toggleLock = useEditor((s) => s.toggleLock);
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
  const Icon = isLayer ? iconForLayer((obj as { type: string }).type) : Folder;
  const children = !isLayer ? (template.groupStacks[entry.id] ?? []) : [];

  function rename(name: string) {
    if (isLayer) updateLayer(entry.id, (l) => { l.name = name; });
    else patch((t) => { const g = t.groups.find((x) => x.id === entry.id); if (g) g.name = name; });
  }

  return (
    <div ref={setNodeRef} className="relative" style={{ transform: CSS.Transform.toString(transform), transition }}>
      {lineBefore && <DropLine position="before" depth={depth} />}
      <div
        onClick={() => select({ kind: entry.kind, id: entry.id })}
        className={cn(
          'group flex h-8 items-center gap-1 pr-2 text-[13px] transition-colors',
          selected ? 'bg-primary/15 text-ink' : 'text-ink-muted hover:bg-surface-2',
          checked && 'bg-info/10 text-ink',
          groupDropActive && 'bg-warning/25 text-ink ring-1 ring-inset ring-warning/80',
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
            groupDropActive && 'bg-warning/25',
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
            deleteSelected();
          }}
          className="grid h-6 w-6 place-items-center text-ink-faint opacity-0 group-hover:opacity-100 hover:text-danger"
          aria-label="Delete"
          title="Delete"
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
      {lineAfter && <DropLine position="after" depth={depth} />}

      {!isLayer && expanded && (
        <Container
          entries={children}
          depth={depth + 1}
          selectMode={selectMode}
          selectedKeys={selectedKeys}
          onToggleEntry={onToggleEntry}
          dragIntent={dragIntent}
        />
      )}
    </div>
  );
}

function DropLine({ position, depth }: { position: 'before' | 'after'; depth: number }) {
  return (
    <div
      className={cn(
        'pointer-events-none absolute left-2 right-2 z-sticky h-0.5 rounded-full bg-primary shadow-[0_0_0_1px_oklch(var(--primary)/0.18)]',
        position === 'before' ? 'top-0' : 'top-8',
      )}
      style={{ marginLeft: 8 + depth * 14 }}
      aria-hidden
    />
  );
}
