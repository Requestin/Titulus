import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Variable } from '@runtime';
import {
  Plus, FileUp, FileDown, Copy, Trash2, Pencil, ChevronDown, ChevronRight,
  ArrowUp, ArrowDown, GripVertical, Folder,
} from 'lucide-react';
import {
  api,
  type Channel,
  type DataElement,
  type OnAirSnapshot,
  type Rundown,
  type OnAirDetailsSnapshot,
  type RundownSlot,
  type TemplateRecord,
  type TemplateSummary,
} from '@/core/api';
import { prepareForAir } from '@/control/prepareForAir';
import { continueCommand, isWaitingContinue } from '@/control/onAirContinue';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/form';
import { cn } from '@/lib/cn';
import { toast } from '@/core/toast';
import { createId } from '@/core/id';

export const MIME_TEMPLATE = 'application/x-titulus-template';
export const MIME_DATA_ELEMENT = 'application/x-titulus-data-element';
export const MIME_SLOT_REORDER = 'application/x-titulus-slot-reorder';

type SendControl = (cmd: {
  type: 'take' | 'update' | 'clear' | 'continue';
  channelId: string;
  templateId?: string;
  template?: unknown;
  variables?: Record<string, string | number>;
}) => boolean;

type ReorderPayload = {
  slotId: string;
  parentId: string | null;
};

function isPrimary(slot: RundownSlot): boolean {
  return slot.kind === 'primary';
}

function isItem(slot: RundownSlot): boolean {
  return !isPrimary(slot);
}

export function RundownTab({
  channels: _channels,
  templates,
  rundowns,
  setRundowns,
  dataLoaded,
  onAir,
  setOnAir,
  fallbackChannelId,
  send,
  onAirDetails,
  onPreferredChannelChange,
  dataElements = [],
  selectedRundownId,
  onSelectRundown,
  showRundownList = true,
}: {
  channels: Channel[];
  templates: TemplateSummary[];
  rundowns: Rundown[];
  setRundowns: React.Dispatch<React.SetStateAction<Rundown[]>>;
  dataLoaded: boolean;
  onAir: OnAirSnapshot;
  setOnAir: React.Dispatch<React.SetStateAction<OnAirSnapshot>>;
  fallbackChannelId: string;
  send: SendControl;
  onAirDetails?: OnAirDetailsSnapshot | null;
  onPreferredChannelChange?: (channelId: string) => void;
  dataElements?: DataElement[];
  selectedRundownId?: string | null;
  onSelectRundown?: (id: string | null) => void;
  showRundownList?: boolean;
}) {
  const controlled = selectedRundownId !== undefined;
  const [internalActiveId, setInternalActiveId] = useState<string | null>(null);
  const activeId = controlled ? (selectedRundownId ?? null) : internalActiveId;
  const setActiveId = useCallback((id: string | null) => {
    if (!controlled) setInternalActiveId(id);
    onSelectRundown?.(id);
  }, [controlled, onSelectRundown]);

  const [bootstrapping, setBootstrapping] = useState(false);
  const bootstrapAttempted = useRef(false);
  const [focusPath, setFocusPath] = useState<{ parentId: string | null; index: number }>({
    parentId: null,
    index: 0,
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const [renamingSlotId, setRenamingSlotId] = useState<string | null>(null);
  const [renameSlotVal, setRenameSlotVal] = useState('');
  const [cache, setCache] = useState<Record<string, TemplateRecord>>({});
  const [dropHint, setDropHint] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const active = useMemo(() => rundowns.find((r) => r.id === activeId) ?? null, [rundowns, activeId]);
  // Air target is always the Control top-bar channel; rundowns are scoped to that channel.
  const channelId = fallbackChannelId || 'default';
  const channelLiveSet = new Set(onAir[channelId] ?? []);

  const flatTakeable = useMemo(() => {
    if (!active) return [] as Array<{ slot: RundownSlot; parentId: string | null; index: number }>;
    const out: Array<{ slot: RundownSlot; parentId: string | null; index: number }> = [];
    active.slots.forEach((slot, index) => {
      if (isItem(slot)) out.push({ slot, parentId: null, index });
      if (isPrimary(slot)) {
        (slot.children ?? []).forEach((child, childIndex) => {
          if (isItem(child)) out.push({ slot: child, parentId: slot.slotId, index: childIndex });
        });
      }
    });
    return out;
  }, [active]);

  const activeLiveSet = useMemo(() => {
    const ids = new Set<string>();
    for (const row of flatTakeable) {
      if (channelLiveSet.has(row.slot.slotId)) ids.add(row.slot.slotId);
    }
    return ids;
  }, [flatTakeable, channelLiveSet]);

  useEffect(() => {
    if (!activeId && rundowns.length) setActiveId(rundowns[0].id);
    if (activeId && !rundowns.some((r) => r.id === activeId)) setActiveId(rundowns[0]?.id ?? null);
  }, [rundowns, activeId, setActiveId]);

  useEffect(() => {
    bootstrapAttempted.current = false;
  }, [fallbackChannelId]);

  useEffect(() => {
    if (!dataLoaded || rundowns.length > 0 || bootstrapAttempted.current) return;
    bootstrapAttempted.current = true;
    setBootstrapping(true);
    void api.rundowns.create({ name: 'Rundown 1', channel_id: fallbackChannelId || null, slots: [] })
      .then((rd) => {
        setRundowns([rd]);
        setActiveId(rd.id);
      })
      .catch((e) => {
        bootstrapAttempted.current = false;
        toast.error(`Failed to create default rundown: ${(e as Error).message}`);
      })
      .finally(() => setBootstrapping(false));
  }, [dataLoaded, rundowns.length, setRundowns, setActiveId, fallbackChannelId]);

  useEffect(() => onPreferredChannelChange?.(channelId), [channelId, onPreferredChannelChange]);

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }, []);

  useEffect(() => {
    if (!active) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void api.rundowns.update(active.id, {
        name: active.name,
        channel_id: active.channel_id ?? (fallbackChannelId || null),
        slots: active.slots,
      }).catch((e) => toast.error(`Autosave failed: ${(e as Error).message}`));
    }, 450);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [active, fallbackChannelId]);

  const patchActive = useCallback((updater: (r: Rundown) => Rundown) => {
    if (!activeId) return;
    setRundowns((prev) => prev.map((r) => (r.id === activeId ? updater(r) : r)));
  }, [activeId, setRundowns]);

  const ensureTemplate = useCallback(async (id: string) => {
    if (cache[id]) return cache[id];
    const rec = await api.templates.get(id);
    setCache((prev) => ({ ...prev, [id]: rec }));
    return rec;
  }, [cache]);

  function patchOnAir(nextChannelId: string, updater: (cur: string[]) => string[]) {
    setOnAir((prev) => ({ ...prev, [nextChannelId]: updater(prev[nextChannelId] ?? []) }));
  }

  function buildPayload(slot: RundownSlot, varsDef: Variable[]) {
    const de = dataElements.find((item) => item.id === slot.dataElementId);
    const fromDe = de ? flattenPayload(de.payload) : {};
    const v: Record<string, string | number> = { ...fromDe };
    for (const d of varsDef) v[d.id] = slot.vars[d.id] ?? v[d.id] ?? d.defaultValue;
    return v;
  }

  async function takeSlot(slot: RundownSlot) {
    if (!isItem(slot) || !slot.templateId) return;
    const tpl = await ensureTemplate(slot.templateId).catch(() => null);
    if (!tpl) return;
    const values = buildPayload(slot, tpl.data.variables);
    const prepared = await prepareForAir(tpl.data, 'take', values);
    if (prepared.blocked) return toast.error(prepared.errors[0]?.message || 'Data pipeline blocked TAKE');
    const ok = send({
      type: 'take',
      channelId,
      templateId: slot.slotId,
      template: prepared.template ?? tpl.data,
      variables: { ...values, ...prepared.overrides },
    });
    if (!ok) return toast.error('Control socket disconnected');
    patchOnAir(channelId, (cur) => Array.from(new Set([...cur, slot.slotId])));
  }

  /** TAKE every nested item top→bottom so same-layer ownership keeps the lower row. */
  async function takePrimary(slot: RundownSlot) {
    if (!isPrimary(slot)) return;
    const children = (slot.children ?? []).filter(isItem);
    if (children.length === 0) return;
    for (const child of children) {
      await takeSlot(child);
    }
  }

  function clearSlot(slotId: string) {
    const ok = send({ type: 'clear', channelId, templateId: slotId });
    if (!ok) return toast.error('Control socket disconnected');
    patchOnAir(channelId, (cur) => cur.filter((id) => id !== slotId));
  }

  function mapSlots(
    slots: RundownSlot[],
    parentId: string | null,
    mapper: (list: RundownSlot[]) => RundownSlot[],
  ): RundownSlot[] {
    if (parentId === null) return mapper(slots);
    return slots.map((slot) => {
      if (slot.slotId !== parentId || !isPrimary(slot)) return slot;
      return { ...slot, children: mapper(slot.children ?? []) };
    });
  }

  function getList(slots: RundownSlot[], parentId: string | null): RundownSlot[] {
    if (parentId === null) return slots;
    const parent = slots.find((s) => s.slotId === parentId && isPrimary(s));
    return parent?.children ?? [];
  }

  function mapDeep(slots: RundownSlot[], slotId: string, fn: (s: RundownSlot) => RundownSlot): RundownSlot[] {
    return slots.map((s) => {
      if (s.slotId === slotId) return fn(s);
      if (s.children) return { ...s, children: mapDeep(s.children, slotId, fn) };
      return s;
    });
  }

  async function createRundown() {
    const rd = await api.rundowns.create({
      name: `Rundown ${rundowns.length + 1}`,
      channel_id: fallbackChannelId || null,
      slots: [],
    });
    setRundowns((prev) => [rd, ...prev]);
    setActiveId(rd.id);
  }

  async function duplicateRundown(id: string) {
    const src = rundowns.find((r) => r.id === id);
    if (!src) return;
    const rd = await api.rundowns.create({
      name: `${src.name} (copy)`,
      channel_id: fallbackChannelId || src.channel_id,
      slots: cloneSlotsWithNewIds(src.slots),
    });
    setRundowns((prev) => [rd, ...prev]);
    setActiveId(rd.id);
  }

  async function removeRundown(id: string) {
    if (rundowns.length <= 1) return toast.error('At least one rundown required');
    await api.rundowns.remove(id);
    const next = rundowns.filter((r) => r.id !== id);
    setRundowns(next);
    if (activeId === id) setActiveId(next[0]?.id ?? null);
  }

  async function moveRundown(id: string, dir: -1 | 1) {
    const idx = rundowns.findIndex((r) => r.id === id);
    const to = idx + dir;
    if (idx < 0 || to < 0 || to >= rundowns.length) return;
    const next = [...rundowns];
    const [item] = next.splice(idx, 1);
    next.splice(to, 0, item);
    setRundowns(next);
    await api.rundowns.reorder(next.map((r) => r.id));
  }

  async function importRundown(file: File) {
    const text = await file.text();
    const parsed = JSON.parse(text) as { name?: unknown; slots?: unknown };
    const slots = Array.isArray(parsed.slots)
      ? parsed.slots.map((raw, i) => normalizeImportedSlot(raw, i)).filter(Boolean) as RundownSlot[]
      : [];
    const rd = await api.rundowns.create({
      name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : 'Imported rundown',
      channel_id: fallbackChannelId || null,
      slots: cloneSlotsWithNewIds(slots),
    });
    setRundowns((prev) => [rd, ...prev]);
    setActiveId(rd.id);
  }

  function exportRundown(rd: Rundown) {
    const blob = new Blob([JSON.stringify(rd, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${rd.name.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'rundown'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function addPrimary() {
    patchActive((r) => ({
      ...r,
      slots: [...r.slots, { slotId: createId(), kind: 'primary', name: 'Primary', vars: {}, children: [] }],
    }));
  }

  function appendItem(parentId: string | null, item: RundownSlot) {
    patchActive((r) => ({
      ...r,
      slots: mapSlots(r.slots, parentId, (list) => [...list, item]),
    }));
    if (parentId) {
      setExpanded((prev) => new Set(prev).add(parentId));
    }
  }

  function parseDragPayload(dt: DataTransfer): { kind: 'template' | 'dataElement'; data: Record<string, unknown> } | null {
    const tplRaw = dt.getData(MIME_TEMPLATE) || dt.getData('text/plain');
    const deRaw = dt.getData(MIME_DATA_ELEMENT);
    try {
      if (deRaw) {
        const data = JSON.parse(deRaw) as Record<string, unknown>;
        if (typeof data.templateId === 'string') return { kind: 'dataElement', data };
      }
      if (tplRaw) {
        const data = JSON.parse(tplRaw) as Record<string, unknown>;
        if (typeof data.templateId === 'string') return { kind: 'template', data };
      }
    } catch {
      return null;
    }
    return null;
  }

  function slotFromDrag(payload: { kind: 'template' | 'dataElement'; data: Record<string, unknown> }): RundownSlot | null {
    const templateId = typeof payload.data.templateId === 'string' ? payload.data.templateId : '';
    if (!templateId) return null;
    if (payload.kind === 'template') {
      const name = typeof payload.data.name === 'string' ? payload.data.name : 'Slot';
      return { slotId: createId(), kind: 'item', templateId, name, vars: {} };
    }
    const name = typeof payload.data.name === 'string' ? payload.data.name : 'Slot';
    const dataElementId = typeof payload.data.dataElementId === 'string' ? payload.data.dataElementId : undefined;
    const varsIn = (payload.data.vars ?? payload.data.payload ?? {}) as Record<string, unknown>;
    const vars: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(varsIn)) {
      if (typeof v === 'string' || typeof v === 'number') vars[k] = v;
    }
    return { slotId: createId(), kind: 'item', templateId, name, vars, ...(dataElementId ? { dataElementId } : {}) };
  }

  function onDropOnto(parentId: string | null, e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDropHint(null);
    if (parentId) {
      setExpanded((prev) => new Set(prev).add(parentId));
    }
    const reorderRaw = e.dataTransfer.getData(MIME_SLOT_REORDER);
    if (reorderRaw) {
      try {
        const payload = JSON.parse(reorderRaw) as ReorderPayload;
        reorderSlot(payload.slotId, payload.parentId, parentId, getList(active?.slots ?? [], parentId).length);
      } catch {
        // ignore
      }
      return;
    }
    const dragged = parseDragPayload(e.dataTransfer);
    if (!dragged) return;
    const slot = slotFromDrag(dragged);
    if (slot) appendItem(parentId, slot);
  }

  function reorderSlot(slotId: string, fromParent: string | null, toParent: string | null, toIndex: number) {
    if (!active) return;
    patchActive((r) => {
      let moving: RundownSlot | null = null;
      const without = mapSlots(r.slots, fromParent, (list) => {
        const idx = list.findIndex((s) => s.slotId === slotId);
        if (idx < 0) return list;
        const next = [...list];
        [moving] = next.splice(idx, 1);
        return next;
      });
      if (!moving) return r;
      // Prevent dropping a primary into another primary's children.
      if (isPrimary(moving) && toParent !== null) return r;
      return {
        ...r,
        slots: mapSlots(without, toParent, (list) => {
          const next = [...list];
          const clamped = Math.max(0, Math.min(toIndex, next.length));
          next.splice(clamped, 0, moving!);
          return next;
        }),
      };
    });
  }

  function onReorderDrop(parentId: string | null, index: number, e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDropHint(null);
    const reorderRaw = e.dataTransfer.getData(MIME_SLOT_REORDER);
    if (reorderRaw) {
      try {
        const payload = JSON.parse(reorderRaw) as ReorderPayload;
        reorderSlot(payload.slotId, payload.parentId, parentId, index);
      } catch {
        // ignore
      }
      return;
    }
    const dragged = parseDragPayload(e.dataTransfer);
    if (!dragged) return;
    const slot = slotFromDrag(dragged);
    if (!slot) return;
    patchActive((r) => ({
      ...r,
      slots: mapSlots(r.slots, parentId, (list) => {
        const next = [...list];
        next.splice(Math.max(0, Math.min(index, next.length)), 0, slot);
        return next;
      }),
    }));
    if (parentId) setExpanded((prev) => new Set(prev).add(parentId));
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!active || flatTakeable.length === 0) return;
      const tag = (e.target as HTMLElement | null)?.tagName || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const focusIdx = flatTakeable.findIndex(
        (row) => row.parentId === focusPath.parentId && row.index === focusPath.index,
      );
      const safeIdx = focusIdx >= 0 ? focusIdx : 0;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = flatTakeable[Math.min(safeIdx + 1, flatTakeable.length - 1)];
        if (next) setFocusPath({ parentId: next.parentId, index: next.index });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = flatTakeable[Math.max(safeIdx - 1, 0)];
        if (prev) setFocusPath({ parentId: prev.parentId, index: prev.index });
      } else if (e.key === ' ') {
        e.preventDefault();
        const row = flatTakeable[safeIdx];
        if (row) void takeSlot(row.slot);
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        const row = flatTakeable[safeIdx];
        if (row && activeLiveSet.has(row.slot.slotId)) clearSlot(row.slot.slotId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, flatTakeable, focusPath, activeLiveSet]);

  const focusedTakeable = flatTakeable.find(
    (row) => row.parentId === focusPath.parentId && row.index === focusPath.index,
  ) ?? flatTakeable[0] ?? null;
  const focusFlatIndex = focusedTakeable
    ? flatTakeable.findIndex((row) => row.slot.slotId === focusedTakeable.slot.slotId)
    : -1;

  if (!dataLoaded || bootstrapping) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <p className="text-[13px] text-ink-muted">
          {!dataLoaded ? 'Loading control data…' : 'Creating default rundown…'}
        </p>
      </div>
    );
  }

  if (rundowns.length === 0) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div className="space-y-3">
          <p className="text-sm font-medium">No rundowns yet</p>
          <p className="text-[13px] text-ink-muted">Create your first rundown to start scenario playout.</p>
          <Button variant="primary" onClick={() => void createRundown().catch((e) => toast.error((e as Error).message))}>
            <Plus className="h-4 w-4" /> Create rundown
          </Button>
        </div>
      </div>
    );
  }

  if (!active) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <p className="text-[13px] text-ink-muted">Preparing rundown…</p>
      </div>
    );
  }

  const listAside = showRundownList ? (
    <aside className="border-r border-border p-2">
      <RundownListPanel
        rundowns={rundowns}
        activeId={activeId}
        renamingId={renamingId}
        renameVal={renameVal}
        importRef={importRef}
        onSelect={setActiveId}
        onCreate={() => void createRundown().catch((e) => toast.error((e as Error).message))}
        onImport={(file) => void importRundown(file).catch((err) => toast.error(`Import failed: ${(err as Error).message}`))}
        onRenameStart={(r) => { setRenamingId(r.id); setRenameVal(r.name); }}
        onRenameChange={setRenameVal}
        onRenameCommit={(r) => {
          setRenamingId(null);
          void api.rundowns.update(r.id, { name: renameVal.trim() || r.name }).then((u) => {
            setRundowns((prev) => prev.map((x) => (x.id === u.id ? u : x)));
          });
        }}
        onRenameCancel={() => setRenamingId(null)}
        onMove={(id, dir) => void moveRundown(id, dir)}
        onDuplicate={(id) => void duplicateRundown(id).catch((e) => toast.error((e as Error).message))}
        onExport={exportRundown}
        onRemove={(id) => void removeRundown(id).catch((e) => toast.error((e as Error).message))}
      />
    </aside>
  ) : null;

  function renderSlotRow(slot: RundownSlot, idx: number, parentId: string | null) {
    const focused = focusPath.parentId === parentId && focusPath.index === idx;
    const primary = isPrimary(slot);
    const childItems = primary ? (slot.children ?? []).filter(isItem) : [];
    const anyChildLive = childItems.some((c) => activeLiveSet.has(c.slotId));
    const live = primary ? anyChildLive : activeLiveSet.has(slot.slotId);
    const nestHint = dropHint === `child:${slot.slotId}`;
    const rowHint = dropHint === `${parentId ?? 'root'}:${idx}`;
    const renaming = renamingSlotId === slot.slotId;

    function resolveDropMode(clientX: number, el: HTMLElement): 'nest' | 'reorder' {
      if (!primary) return 'reorder';
      const rect = el.getBoundingClientRect();
      return clientX >= rect.left + rect.width * 0.55 ? 'nest' : 'reorder';
    }

    return (
      <div key={slot.slotId} className={parentId ? 'pl-4' : undefined}>
        <div
          className={cn(
            'rounded border px-2 py-2',
            live && 'border-transparent',
            !live && (focused ? 'border-primary/70 bg-surface-2' : 'border-border bg-surface'),
            nestHint && 'bg-warning/25 ring-1 ring-inset ring-warning/80',
            !nestHint && rowHint && 'ring-1 ring-primary',
          )}
          style={live ? { backgroundColor: '#371f1f' } : undefined}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const mode = resolveDropMode(e.clientX, e.currentTarget);
            setDropHint(mode === 'nest' ? `child:${slot.slotId}` : `${parentId ?? 'root'}:${idx}`);
          }}
          onDragLeave={() => setDropHint((cur) => (
            cur === `child:${slot.slotId}` || cur === `${parentId ?? 'root'}:${idx}` ? null : cur
          ))}
          onDrop={(e) => {
            const mode = resolveDropMode(e.clientX, e.currentTarget);
            if (mode === 'nest') onDropOnto(slot.slotId, e);
            else onReorderDrop(parentId, idx, e);
          }}
        >
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="cursor-grab text-ink-faint hover:text-ink active:cursor-grabbing"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(MIME_SLOT_REORDER, JSON.stringify({ slotId: slot.slotId, parentId } satisfies ReorderPayload));
                e.dataTransfer.effectAllowed = 'move';
              }}
              aria-label="Drag to reorder"
            >
              <GripVertical className="h-4 w-4" />
            </button>
            {primary ? (
              <button
                type="button"
                className="text-ink-faint hover:text-ink"
                aria-label={expanded.has(slot.slotId) ? 'Collapse' : 'Expand'}
                onClick={() => setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(slot.slotId)) next.delete(slot.slotId); else next.add(slot.slotId);
                  return next;
                })}
              >
                {expanded.has(slot.slotId) ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>
            ) : (
              <span className="w-4" />
            )}
            {primary && <Folder className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden />}
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => setFocusPath({ parentId, index: idx })}
            >
              {renaming && primary ? (
                <Input
                  value={renameSlotVal}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setRenameSlotVal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      patchActive((r) => ({
                        ...r,
                        slots: mapDeep(r.slots, slot.slotId, (s) => ({
                          ...s,
                          name: renameSlotVal.trim() || s.name || 'Primary',
                        })),
                      }));
                      setRenamingSlotId(null);
                    }
                    if (e.key === 'Escape') setRenamingSlotId(null);
                  }}
                  onBlur={() => {
                    patchActive((r) => ({
                      ...r,
                      slots: mapDeep(r.slots, slot.slotId, (s) => ({
                        ...s,
                        name: renameSlotVal.trim() || s.name || 'Primary',
                      })),
                    }));
                    setRenamingSlotId(null);
                  }}
                />
              ) : (
                <>
                  <div className="truncate text-sm font-medium">{slot.name}</div>
                  <div className="truncate text-[11px] text-ink-faint">
                    {primary
                      ? `${(slot.children ?? []).length} items`
                      : (templates.find((t) => t.id === slot.templateId)?.name ?? slot.templateId)}
                  </div>
                </>
              )}
            </button>
            {primary && (
              <button
                type="button"
                className="text-ink-faint hover:text-ink"
                title="Rename"
                onClick={() => {
                  setRenamingSlotId(slot.slotId);
                  setRenameSlotVal(slot.name || 'Primary');
                }}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
            {!primary && (
              <span className={cn(
                'rounded px-1.5 py-0.5 text-[11px] font-semibold',
                focused ? 'bg-primary/20 text-primary' : 'bg-surface-2 text-ink-muted',
                live && 'bg-transparent text-ink-muted',
              )}>
                {focused ? 'NEXT' : 'PENDING'}
              </span>
            )}
            <button
              type="button"
              className="text-ink-faint hover:text-danger"
              onClick={() => patchActive((r) => ({
                ...r,
                slots: mapSlots(r.slots, parentId, (list) => list.filter((s) => s.slotId !== slot.slotId)),
              }))}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
            {primary ? (
              <Button
                size="sm"
                variant="danger"
                disabled={childItems.length === 0}
                title="TAKE all nested items (top to bottom)"
                onClick={() => void takePrimary(slot)}
              >
                TAKE
              </Button>
            ) : (
              <Button
                size="sm"
                variant={live ? 'neutral' : 'danger'}
                onClick={() => (live ? clearSlot(slot.slotId) : void takeSlot(slot))}
              >
                {live ? 'CLEAR' : 'TAKE'}
              </Button>
            )}
          </div>

          {primary && expanded.has(slot.slotId) && (
            <div
              className={cn(
                'mt-2 space-y-2 rounded border border-dashed border-border p-2',
                nestHint && 'border-primary bg-primary/5',
              )}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDropHint(`child:${slot.slotId}`);
              }}
              onDragLeave={() => setDropHint((cur) => (cur === `child:${slot.slotId}` ? null : cur))}
              onDrop={(e) => onDropOnto(slot.slotId, e)}
            >
              {(slot.children ?? []).map((child, childIdx) => renderSlotRow(child, childIdx, slot.slotId))}
              {(slot.children ?? []).length === 0 && (
                <p className="px-1 py-3 text-center text-[12px] text-ink-faint">
                  Drop items here, or drag right onto this primary
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  const editor = (
    <div className="min-h-0 overflow-auto p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded border border-border bg-surface px-3 py-2">
        <Button
          size="sm"
          variant="neutral"
          disabled={focusFlatIndex <= 0}
          onClick={() => {
            const i = Math.max(0, focusFlatIndex - 1);
            const row = flatTakeable[i];
            if (!row) return;
            setFocusPath({ parentId: row.parentId, index: row.index });
            void takeSlot(row.slot);
          }}
        >
          PREV
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!focusedTakeable}
          onClick={() => {
            if (!focusedTakeable) return;
            void takeSlot(focusedTakeable.slot).then(() => {
              const next = flatTakeable[Math.min(focusFlatIndex + 1, flatTakeable.length - 1)];
              if (next) setFocusPath({ parentId: next.parentId, index: next.index });
            });
          }}
        >
          TAKE
        </Button>
        <Button
          size="sm"
          variant="neutral"
          disabled={!focusedTakeable || !isWaitingContinue(onAirDetails, channelId, focusedTakeable.slot.slotId)}
          onClick={() => {
            if (focusedTakeable) send(continueCommand(channelId, focusedTakeable.slot.slotId));
          }}
        >
          CONTINUE
        </Button>
        <Button
          size="sm"
          variant="neutral"
          disabled={focusFlatIndex < 0 || focusFlatIndex >= flatTakeable.length - 1}
          onClick={() => {
            const i = Math.min(flatTakeable.length - 1, focusFlatIndex + 1);
            const row = flatTakeable[i];
            if (!row) return;
            setFocusPath({ parentId: row.parentId, index: row.index });
            void takeSlot(row.slot);
          }}
        >
          NEXT
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            for (const row of flatTakeable) if (activeLiveSet.has(row.slot.slotId)) clearSlot(row.slot.slotId);
          }}
        >
          CLEAR LIVE
        </Button>
        <span className="tnum rounded border border-border px-2 py-1 text-[12px] text-ink-muted">
          {flatTakeable.length === 0 ? '0 / 0' : `${focusFlatIndex + 1} / ${flatTakeable.length}`}
        </span>
      </div>

      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{active.name}</h3>
        <Button size="sm" variant="neutral" onClick={addPrimary}>
          <Plus className="h-4 w-4" /> primary
        </Button>
      </div>

      <div
        className={cn(
          'space-y-2 rounded-md',
          dropHint === 'root' && 'ring-1 ring-primary',
        )}
        onDragOver={(e) => {
          e.preventDefault();
          setDropHint('root');
        }}
        onDragLeave={() => setDropHint((cur) => (cur === 'root' ? null : cur))}
        onDrop={(e) => onDropOnto(null, e)}
      >
        {active.slots.map((slot, idx) => renderSlotRow(slot, idx, null))}
        {active.slots.length === 0 && (
          <div className="rounded border border-dashed border-border px-4 py-8 text-center text-[13px] text-ink-muted">
            Drop templates or data elements here, or add a Primary group.
          </div>
        )}
      </div>
    </div>
  );

  if (!showRundownList) return editor;

  return (
    <div className="grid h-full grid-cols-[250px_1fr]">
      {listAside}
      {editor}
    </div>
  );
}

export function RundownListPanel({
  rundowns,
  activeId,
  renamingId,
  renameVal,
  importRef,
  onSelect,
  onCreate,
  onImport,
  onRenameStart,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onMove,
  onDuplicate,
  onExport,
  onRemove,
}: {
  rundowns: Rundown[];
  activeId: string | null;
  renamingId: string | null;
  renameVal: string;
  importRef: React.RefObject<HTMLInputElement | null>;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onImport: (file: File) => void;
  onRenameStart: (r: Rundown) => void;
  onRenameChange: (value: string) => void;
  onRenameCommit: (r: Rundown) => void;
  onRenameCancel: () => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onDuplicate: (id: string) => void;
  onExport: (r: Rundown) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <>
      <input
        ref={importRef as React.RefObject<HTMLInputElement>}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onImport(f);
          e.target.value = '';
        }}
      />
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12px] font-semibold text-ink-muted">Rundowns</span>
        <div className="flex items-center gap-1">
          <button type="button" className="text-ink-faint hover:text-ink" onClick={() => importRef.current?.click()}>
            <FileUp className="h-4 w-4" />
          </button>
          <button type="button" className="text-ink-faint hover:text-ink" onClick={onCreate}>
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="space-y-1">
        {rundowns.map((r, idx) => (
          <div
            key={r.id}
            className={cn(
              'rounded border px-2 py-1.5',
              r.id === activeId ? 'border-primary/60 bg-surface-2' : 'border-border bg-surface',
            )}
          >
            <div className="flex items-center gap-1">
              <button type="button" className="min-w-0 flex-1 text-left text-[13px] font-medium" onClick={() => onSelect(r.id)}>
                {renamingId === r.id ? (
                  <Input
                    value={renameVal}
                    autoFocus
                    onChange={(e) => onRenameChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') onRenameCommit(r);
                      if (e.key === 'Escape') onRenameCancel();
                    }}
                  />
                ) : r.name}
              </button>
              <button type="button" className="text-ink-faint hover:text-ink" onClick={() => onMove(r.id, -1)} disabled={idx === 0}>
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
              <button type="button" className="text-ink-faint hover:text-ink" onClick={() => onMove(r.id, 1)} disabled={idx === rundowns.length - 1}>
                <ArrowDown className="h-3.5 w-3.5" />
              </button>
              <button type="button" className="text-ink-faint hover:text-ink" onClick={() => onRenameStart(r)}>
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button type="button" className="text-ink-faint hover:text-ink" onClick={() => onDuplicate(r.id)}>
                <Copy className="h-3.5 w-3.5" />
              </button>
              <button type="button" className="text-ink-faint hover:text-ink" onClick={() => onExport(r)}>
                <FileDown className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                className="text-ink-faint hover:text-danger"
                disabled={rundowns.length <= 1}
                onClick={() => onRemove(r.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="mt-1 text-[11px] text-ink-faint">{countSlots(r.slots)} slots</div>
          </div>
        ))}
      </div>
    </>
  );
}

function countSlots(slots: RundownSlot[]): number {
  let n = 0;
  for (const s of slots) {
    n += 1;
    if (s.children) n += countSlots(s.children);
  }
  return n;
}

function cloneSlotsWithNewIds(slots: RundownSlot[]): RundownSlot[] {
  return slots.map((s) => ({
    ...s,
    slotId: createId(),
    children: s.children ? cloneSlotsWithNewIds(s.children) : undefined,
  }));
}

function normalizeImportedSlot(raw: unknown, idx: number): RundownSlot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const slot = raw as Record<string, unknown>;
  if (slot.kind === 'ue') return null;
  if (slot.kind === 'primary') {
    const childrenRaw = Array.isArray(slot.children) ? slot.children : [];
    const children = childrenRaw
      .map((child, i) => normalizeImportedSlot(child, i))
      .filter((child): child is RundownSlot => !!child && child.kind !== 'primary');
    return {
      slotId: typeof slot.slotId === 'string' && slot.slotId.trim() ? slot.slotId.trim() : createId(),
      kind: 'primary',
      name: typeof slot.name === 'string' && slot.name.trim() ? slot.name.trim() : 'Primary',
      vars: {},
      children,
    };
  }
  const templateId = typeof slot.templateId === 'string' ? slot.templateId.trim() : '';
  if (!templateId) return null;
  const name = typeof slot.name === 'string' && slot.name.trim()
    ? slot.name.trim()
    : (typeof slot.label === 'string' && slot.label.trim() ? slot.label.trim() : `Slot ${idx + 1}`);
  const varsIn = (slot.vars ?? slot.variables ?? {}) as Record<string, unknown>;
  const vars: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(varsIn)) {
    if (typeof v === 'string' || typeof v === 'number') vars[k] = v;
  }
  const dataElementId = typeof slot.dataElementId === 'string' && slot.dataElementId.trim()
    ? slot.dataElementId.trim()
    : undefined;
  return {
    slotId: typeof slot.slotId === 'string' && slot.slotId.trim() ? slot.slotId.trim() : createId(),
    kind: 'item',
    templateId,
    name,
    vars,
    ...(dataElementId ? { dataElementId } : {}),
  };
}

function flattenPayload(payload: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (typeof value === 'string' || typeof value === 'number') out[key] = value;
  }
  return out;
}
