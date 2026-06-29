// frontend/src/editor/panels/LayersPanel.tsx
//
// Layer tree: top-level stack + groups (expandable), reorder within a container
// via @dnd-kit, visibility/lock/select/rename/delete, add layer, new group.
// Display is reversed so the frontmost layer (last in stack) sits on top.

import { useState, type ComponentType } from 'react';
import {
  DndContext, PointerSensor, useSensor, useSensors, closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, useSortable, arrayMove, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Type, Square, Image as ImageIcon, Video, Clock, Folder,
  Eye, EyeOff, Lock, Unlock, GripVertical, ChevronRight, ChevronDown,
  Plus, FolderPlus,
} from 'lucide-react';
import type { LayerType, RootStackEntry } from '@runtime';
import { useEditor } from '../store';
import { LAYER_TYPES, LAYER_LABEL } from '../factories';
import { cn } from '@/lib/cn';

const LAYER_ICON: Record<LayerType, ComponentType<{ className?: string }>> = {
  text: Type, rect: Square, image: ImageIcon, video: Video, clock: Clock, mask: MaskIcon,
};

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
  const [addOpen, setAddOpen] = useState(false);
  if (!template) return null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-[12px] font-semibold text-ink-muted">Layers</span>
        <div className="relative flex items-center gap-1">
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
        <Container containerId={null} entries={template.rootStack} depth={0} />
        {template.rootStack.length === 0 && (
          <p className="px-3 py-6 text-center text-[12px] text-ink-faint">
            No layers. Use + to add one.
          </p>
        )}
      </div>
    </div>
  );
}

function Container({
  containerId,
  entries,
  depth,
}: {
  containerId: string | null;
  entries: RootStackEntry[];
  depth: number;
}) {
  const reorderContainer = useEditor((s) => s.reorderContainer);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // Reversed so frontmost (last in stack) shows on top.
  const display = [...entries].reverse();
  const ids = display.map((e) => `${e.kind}:${e.id}`);

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const nextDisplay = arrayMove(display, from, to);
    reorderContainer(containerId, [...nextDisplay].reverse().map((x) => x.id));
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {display.map((entry) => (
          <Row key={`${entry.kind}:${entry.id}`} entry={entry} depth={depth} />
        ))}
      </SortableContext>
    </DndContext>
  );
}

function Row({ entry, depth }: { entry: RootStackEntry; depth: number }) {
  const template = useEditor((s) => s.template)!;
  const selection = useEditor((s) => s.selection);
  const select = useEditor((s) => s.select);
  const toggleVisible = useEditor((s) => s.toggleVisible);
  const toggleLock = useEditor((s) => s.toggleLock);
  const updateLayer = useEditor((s) => s.updateLayer);
  const patch = useEditor((s) => s.patch);
  const [expanded, setExpanded] = useState(true);
  const [renaming, setRenaming] = useState(false);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `${entry.kind}:${entry.id}`,
  });

  const isLayer = entry.kind === 'layer';
  const obj = isLayer
    ? template.layers.find((l) => l.id === entry.id)
    : template.groups.find((g) => g.id === entry.id);
  if (!obj) return null;

  const selected = selection?.kind === entry.kind && selection.id === entry.id;
  const Icon = isLayer ? LAYER_ICON[(obj as { type: LayerType }).type] : Folder;
  const children = !isLayer ? (template.groupStacks[entry.id] ?? []) : [];

  function rename(name: string) {
    if (isLayer) updateLayer(entry.id, (l) => { l.name = name; });
    else patch((t) => { const g = t.groups.find((x) => x.id === entry.id); if (g) g.name = name; });
  }

  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <div
        onClick={() => select({ kind: entry.kind, id: entry.id })}
        className={cn(
          'group flex h-8 items-center gap-1 pr-2 text-[13px]',
          selected ? 'bg-primary/15 text-ink' : 'text-ink-muted hover:bg-surface-2',
          isDragging && 'opacity-60',
        )}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        <button
          {...attributes}
          {...listeners}
          className="grid h-5 w-4 cursor-grab place-items-center text-ink-faint opacity-0 group-hover:opacity-100"
          aria-label="Drag to reorder"
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
        <Container containerId={entry.id} entries={children} depth={depth + 1} />
      )}
    </div>
  );
}
