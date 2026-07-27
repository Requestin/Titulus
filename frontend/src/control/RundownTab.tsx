import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  Plus, FileUp, FileDown, Copy, Trash2, Pencil, GripVertical, X,
  ArrowRight, ChevronsRight, Square,
} from 'lucide-react';
import {
  DndContext, PointerSensor, closestCenter, useSensor, useSensors, useDroppable, useDraggable,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, useSortable, verticalListSortingStrategy, arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  api,
  ApiError,
  type DataElement,
  type OnAirSnapshot,
  type Rundown,
  type RundownSlot,
  type TemplateFolder,
  type TemplateRecord,
  type TemplateSummary,
} from '@/core/api';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/form';
import { cn } from '@/lib/cn';
import { toast } from '@/core/toast';
import { createId } from '@/core/id';
import { crawlFileErrorMessage } from '@/core/crawlFile';
import { prepareTemplateForAir, templateDataErrorMessage } from '@/core/prepareTemplateData';
import { isUpdateDirectorArmed } from '@runtime';
import { ProgramMonitor } from '@/control/ProgramMonitor';
import {
  ControlVariablesPanel,
  buildValuesFromVars,
  defaultsFromVariables,
  type VarsSelection,
} from '@/control/ControlVariablesPanel';

type SendControl = (cmd: {
  type: 'take' | 'update' | 'clear' | 'continue';
  channelId: string;
  templateId?: string;
  template?: unknown;
  variables?: Record<string, string | number>;
  slotId?: string;
}) => boolean;

type SidebarMode = 'rundowns' | 'templates' | 'dataElements';
const ALL_FOLDER = '__all__';
const ALL_TEMPLATE = '__all__';

function templateFolderIdOf(t: TemplateSummary): string | null {
  return t.folderId ?? t.folder_id ?? null;
}

const LAST_RUNDOWN_KEY = (channelId: string) => `titulus.control.lastRundown.${channelId}`;
const SIDEBAR_WIDTH_KEY = 'titulus.control.sidebarWidth';
const SIDEBAR_WIDTH_DEFAULT = 250;
const SIDEBAR_WIDTH_MIN = 180;
const SIDEBAR_WIDTH_MAX = 520;

function dragIdTemplate(id: string) { return `tpl:${id}`; }
function dragIdDataElement(id: string) { return `de:${id}`; }
function parseDragId(id: string): { kind: 'template' | 'dataElement' | 'slot' | 'rundown'; id: string } | null {
  if (id.startsWith('tpl:')) return { kind: 'template', id: id.slice(4) };
  if (id.startsWith('de:')) return { kind: 'dataElement', id: id.slice(3) };
  if (id.startsWith('slot:')) return { kind: 'slot', id: id.slice(5) };
  if (id.startsWith('rd:')) return { kind: 'rundown', id: id.slice(3) };
  return null;
}

export function RundownTab({
  channelId,
  templates,
  rundowns,
  setRundowns,
  dataLoaded,
  onAir,
  setOnAir,
  send,
}: {
  channelId: string;
  templates: TemplateSummary[];
  rundowns: Rundown[];
  setRundowns: React.Dispatch<React.SetStateAction<Rundown[]>>;
  dataLoaded: boolean;
  onAir: OnAirSnapshot;
  setOnAir: React.Dispatch<React.SetStateAction<OnAirSnapshot>>;
  send: SendControl;
}) {
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('rundowns');
  const [folders, setFolders] = useState<TemplateFolder[]>([]);
  const [sidebarFolderId, setSidebarFolderId] = useState<string>(ALL_FOLDER);
  const [sidebarTemplateId, setSidebarTemplateId] = useState<string>(ALL_TEMPLATE);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [focusIdx, setFocusIdx] = useState(0);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const [cache, setCache] = useState<Record<string, TemplateRecord>>({});
  const [dataElements, setDataElements] = useState<DataElement[]>([]);
  const [deSort, setDeSort] = useState<'updated' | 'name'>('updated');
  const [varsSelection, setVarsSelection] = useState<VarsSelection>({ kind: 'none' });
  const [selectedSidebarId, setSelectedSidebarId] = useState<string | null>(null);
  const [deSelectedIds, setDeSelectedIds] = useState<Set<string>>(() => new Set());
  const [deAnchorId, setDeAnchorId] = useState<string | null>(null);
  const [deDeleteIds, setDeDeleteIds] = useState<string[] | null>(null);
  const [deDeleting, setDeDeleting] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (!Number.isFinite(raw)) return SIDEBAR_WIDTH_DEFAULT;
    return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, raw));
  });
  const sidebarResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveUpdateTimers = useRef<Record<string, ReturnType<typeof setTimeout> | undefined>>({});
  const importRef = useRef<HTMLInputElement>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const active = useMemo(() => rundowns.find((r) => r.id === activeId) ?? null, [rundowns, activeId]);
  const channelEntries = onAir[channelId] ?? [];
  const channelLiveTemplateIds = new Set(channelEntries.map((e) => e.templateId));
  const ownerByTemplate = new Map(
    channelEntries.filter((e) => e.slotId).map((e) => [e.templateId, e.slotId!] as const),
  );
  const waitingByTemplate = new Map(
    channelEntries.map((e) => [e.templateId, !!e.waitingContinue] as const),
  );
  const activeLiveSet = new Set(
    (active?.slots ?? [])
      .filter((s) => ownerByTemplate.get(s.templateId) === s.slotId)
      .map((s) => s.slotId),
  );
  const deById = useMemo(() => new Map(dataElements.map((d) => [d.id, d])), [dataElements]);

  const reloadDataElements = useCallback(async (sort: 'updated' | 'name' = deSort) => {
    try {
      setDataElements(await api.dataElements.list({ sort }));
    } catch (e) {
      toast.error(`Failed to load data elements: ${(e as Error).message}`);
    }
  }, [deSort]);

  useEffect(() => {
    void reloadDataElements(deSort);
  }, [reloadDataElements, deSort]);

  useEffect(() => {
    void (async () => {
      try {
        setFolders(await api.templateFolders.list());
      } catch {
        setFolders([]);
      }
    })();
  }, []);

  const templatesInFolder = useMemo(() => {
    if (sidebarFolderId === ALL_FOLDER) return templates;
    return templates.filter((t) => templateFolderIdOf(t) === sidebarFolderId);
  }, [templates, sidebarFolderId]);

  const templatesSorted = useMemo(
    () => [...templatesInFolder].sort((a, b) => a.name.localeCompare(b.name)),
    [templatesInFolder],
  );

  const filteredDataElements = useMemo(() => {
    const allowedTpl = new Set(templatesInFolder.map((t) => t.id));
    let list = dataElements.filter((de) => allowedTpl.has(de.templateId));
    if (sidebarTemplateId !== ALL_TEMPLATE) {
      list = list.filter((de) => de.templateId === sidebarTemplateId);
    }
    return list;
  }, [dataElements, templatesInFolder, sidebarTemplateId]);

  // Restore last rundown when channel changes.
  useEffect(() => {
    if (!dataLoaded || !channelId) return;
    const saved = localStorage.getItem(LAST_RUNDOWN_KEY(channelId));
    if (saved && rundowns.some((r) => r.id === saved)) {
      setActiveId(saved);
    } else {
      setActiveId(rundowns[0]?.id ?? null);
    }
    // Only re-pick when channel or loaded list identity for this channel changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, dataLoaded, rundowns.map((r) => r.id).join(',')]);

  useEffect(() => {
    if (activeId && channelId) localStorage.setItem(LAST_RUNDOWN_KEY(channelId), activeId);
  }, [activeId, channelId]);

  // Keep activeId valid if list shrinks.
  useEffect(() => {
    if (activeId && rundowns.length && !rundowns.some((r) => r.id === activeId)) {
      setActiveId(rundowns[0]?.id ?? null);
    }
    if (!activeId && rundowns.length) setActiveId(rundowns[0].id);
  }, [rundowns, activeId]);

  useEffect(() => {
    const max = Math.max(0, (active?.slots.length ?? 1) - 1);
    setFocusIdx((i) => Math.min(i, max));
  }, [active?.slots.length]);

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    for (const t of Object.values(liveUpdateTimers.current)) if (t) clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!active) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void api.rundowns.update(active.id, {
        name: active.name,
        channel_id: active.channel_id,
        slots: active.slots,
      }).catch((e) => toast.error(`Autosave failed: ${(e as Error).message}`));
    }, 450);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [active]);

  useEffect(() => {
    setSelectedSidebarId(null);
    setDeSelectedIds(new Set());
    setDeAnchorId(null);
    setDeDeleteIds(null);
    setSidebarFolderId(ALL_FOLDER);
    setSidebarTemplateId(ALL_TEMPLATE);
    if (sidebarMode !== 'rundowns') {
      setVarsSelection({ kind: 'none' });
    }
  }, [sidebarMode]);

  useEffect(() => {
    // Keep template filter valid when folder changes.
    if (sidebarTemplateId === ALL_TEMPLATE) return;
    if (!templatesInFolder.some((t) => t.id === sidebarTemplateId)) {
      setSidebarTemplateId(ALL_TEMPLATE);
    }
  }, [sidebarFolderId, templatesInFolder, sidebarTemplateId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (deDeleteIds) {
        if (e.key === 'Enter') {
          e.preventDefault();
          void confirmDeleteDataElements();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          if (!deDeleting) setDeDeleteIds(null);
        }
        return;
      }

      if (sidebarMode === 'dataElements' && (e.key === 'Delete' || e.key === 'Backspace') && deSelectedIds.size > 0) {
        e.preventDefault();
        setDeDeleteIds([...deSelectedIds]);
        return;
      }

      if (!active || active.slots.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusIdx((i) => Math.min(i + 1, active.slots.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === ' ') {
        e.preventDefault();
        void takeAt(focusIdx);
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        const s = active.slots[focusIdx];
        if (s && activeLiveSet.has(s.slotId)) clearSlot(s.slotId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, focusIdx, activeLiveSet, sidebarMode, deSelectedIds, deDeleteIds, deDeleting]);

  const onSidebarResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    sidebarResizeRef.current = { startX: e.clientX, startWidth: sidebarWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onSidebarResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = sidebarResizeRef.current;
    if (!drag) return;
    const next = Math.min(
      SIDEBAR_WIDTH_MAX,
      Math.max(SIDEBAR_WIDTH_MIN, drag.startWidth + (e.clientX - drag.startX)),
    );
    setSidebarWidth(next);
  };

  const onSidebarResizeEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = sidebarResizeRef.current;
    if (!drag) return;
    const next = Math.min(
      SIDEBAR_WIDTH_MAX,
      Math.max(SIDEBAR_WIDTH_MIN, drag.startWidth + (e.clientX - drag.startX)),
    );
    setSidebarWidth(next);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
    sidebarResizeRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

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

  function slotMissing(slot: RundownSlot): boolean {
    if (slot.kind === 'ue') return false; // resolved via /api/ue-templates at TAKE time
    const tplMissing = !templates.some((t) => t.id === slot.templateId);
    const deMissing = Boolean(slot.dataElementId) && !deById.has(slot.dataElementId!);
    return tplMissing || deMissing;
  }

  function slotDisplayName(slot: RundownSlot): { primary: string; secondary: string | null } {
    if (slot.kind === 'ue') return { primary: slot.name, secondary: 'UE' };
    const tplName = templates.find((t) => t.id === slot.templateId)?.name ?? slot.templateId;
    if (slot.dataElementId) {
      const deName = deById.get(slot.dataElementId)?.name ?? slot.name;
      return { primary: deName, secondary: tplName };
    }
    return { primary: '<template>', secondary: tplName };
  }

  function patchOnAir(nextChannelId: string, updater: (cur: OnAirSnapshot[string]) => OnAirSnapshot[string]) {
    setOnAir((prev) => ({ ...prev, [nextChannelId]: updater(prev[nextChannelId] ?? []) }));
  }

  function buildPayload(slot: RundownSlot, varsDef: { id: string; defaultValue: string | number }[]) {
    const v: Record<string, string | number> = {};
    for (const d of varsDef) v[d.id] = slot.vars[d.id] ?? d.defaultValue;
    return v;
  }

  async function takeAt(index: number) {
    if (!active) return;
    const slot = active.slots[index];
    if (!slot) return;

    // Unreal Blueprint template: Remote Control Take In (not CEF WS take).
    if (slot.kind === 'ue') {
      try {
        await api.ueTemplates.play(slot.templateId, { channelId, mode: 'takeIn' });
        toast.success(`UE Take In: ${slot.name}`);
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : (e as Error).message);
      }
      return;
    }

    if (slotMissing(slot)) {
      toast.error('NOT FOUND IN DB — cannot TAKE');
      return;
    }
    const tpl = await ensureTemplate(slot.templateId).catch(() => null);
    if (!tpl) {
      toast.error('NOT FOUND IN DB — cannot TAKE');
      return;
    }
    let template = tpl.data;
    let variables = buildPayload(slot, template.variables);
    try {
      const prepared = await prepareTemplateForAir(tpl.data, variables, 'take');
      template = prepared.template;
      variables = prepared.variables;
      setCache((prev) => ({ ...prev, [tpl.id]: { ...tpl, data: template } }));
    } catch (err) {
      toast.error(templateDataErrorMessage(err) || crawlFileErrorMessage(err));
      return;
    }
    const alreadyLive = channelLiveTemplateIds.has(slot.templateId);

    if (alreadyLive) {
      if (isUpdateDirectorArmed(template.timeline)) {
        const ok = send({
          type: 'update',
          channelId,
          templateId: slot.templateId,
          template,
          variables,
          slotId: slot.slotId,
        });
        if (!ok) return toast.error('Control socket disconnected');
        patchOnAir(channelId, (cur) => cur.map((e) => (
          e.templateId === slot.templateId
            ? { ...e, templateId: slot.templateId, slotId: slot.slotId, waitingContinue: false }
            : e
        )));
        return;
      }
      const cleared = send({ type: 'clear', channelId, templateId: slot.templateId, slotId: slot.slotId });
      if (!cleared) return toast.error('Control socket disconnected');
    }

    const ok = send({
      type: 'take',
      channelId,
      templateId: slot.templateId,
      template,
      variables,
      slotId: slot.slotId,
    });
    if (!ok) return toast.error('Control socket disconnected');
    patchOnAir(channelId, (cur) => {
      const without = cur.filter((e) => e.templateId !== slot.templateId);
      return [...without, { templateId: slot.templateId, slotId: slot.slotId }];
    });
  }

  function clearSlot(slotId: string) {
    const slot = active?.slots.find((s) => s.slotId === slotId);
    if (slot?.kind === 'ue') {
      void api.ueTemplates.play(slot.templateId, { channelId, mode: 'takeOut' })
        .then(() => toast.success(`UE Take Out: ${slot.name}`))
        .catch((e) => toast.error(e instanceof ApiError ? e.message : (e as Error).message));
      return;
    }
    const templateId = slot?.templateId ?? slotId;
    const ok = send({ type: 'clear', channelId, templateId, slotId });
    if (!ok) return toast.error('Control socket disconnected');
    patchOnAir(channelId, (cur) => cur.filter((e) => e.templateId !== templateId));
  }

  function continueSlot(slotId: string) {
    if (!activeLiveSet.has(slotId)) return;
    const slot = active?.slots.find((s) => s.slotId === slotId);
    const templateId = slot?.templateId ?? slotId;
    const ok = send({ type: 'continue', channelId, templateId, slotId });
    if (!ok) toast.error('Control socket disconnected');
  }

  async function updateLive(slotId: string, vars: Record<string, string | number>) {
    if (!activeLiveSet.has(slotId)) return;
    const slot = active?.slots.find((s) => s.slotId === slotId);
    const templateId = slot?.templateId ?? slotId;
    try {
      const tpl = await ensureTemplate(templateId);
      const prepared = await prepareTemplateForAir(tpl.data, vars, 'update');
      const ok = send({
        type: 'update',
        channelId,
        templateId,
        template: prepared.template,
        variables: prepared.variables,
        slotId,
      });
      if (!ok) toast.error('Control socket disconnected');
    } catch (err) {
      toast.error(templateDataErrorMessage(err));
      const ok = send({ type: 'update', channelId, templateId, variables: vars, slotId });
      if (!ok) toast.error('Control socket disconnected');
    }
  }

  async function selectTemplate(t: TemplateSummary) {
    setSelectedSidebarId(t.id);
    const rec = await ensureTemplate(t.id).catch(() => null);
    if (!rec) {
      toast.error('Failed to load template');
      return;
    }
    setVarsSelection({
      kind: 'template',
      templateId: t.id,
      templateName: t.name,
      variables: rec.data.variables,
      values: defaultsFromVariables(rec.data.variables),
    });
  }

  async function selectDataElement(de: DataElement) {
    setSelectedSidebarId(de.id);
    const rec = await ensureTemplate(de.templateId).catch(() => null);
    const variables = rec?.data.variables ?? [];
    setVarsSelection({
      kind: 'dataElement',
      dataElement: de,
      variables,
      values: buildValuesFromVars(variables, de.vars),
    });
  }

  function onDataElementClick(de: DataElement, e: React.MouseEvent) {
    if (e.shiftKey && deAnchorId) {
      const ids = dataElements.map((d) => d.id);
      const a = ids.indexOf(deAnchorId);
      const b = ids.indexOf(de.id);
      if (a >= 0 && b >= 0) {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        setDeSelectedIds(new Set(ids.slice(lo, hi + 1)));
        void selectDataElement(de);
        return;
      }
    }
    setDeSelectedIds(new Set([de.id]));
    setDeAnchorId(de.id);
    void selectDataElement(de);
  }

  function requestDeleteDataElements(ids: string[]) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return;
    setDeDeleteIds(unique);
  }

  async function confirmDeleteDataElements() {
    if (!deDeleteIds?.length || deDeleting) return;
    const ids = deDeleteIds;
    setDeDeleting(true);
    try {
      await Promise.all(ids.map((id) => api.dataElements.remove(id)));
      setDataElements((prev) => prev.filter((d) => !ids.includes(d.id)));
      setDeSelectedIds((prev) => {
        const next = new Set([...prev].filter((id) => !ids.includes(id)));
        return next;
      });
      if (ids.includes(deAnchorId ?? '')) setDeAnchorId(null);
      if (varsSelection.kind === 'dataElement' && ids.includes(varsSelection.dataElement.id)) {
        setVarsSelection({ kind: 'none' });
        setSelectedSidebarId(null);
      }
      setDeDeleteIds(null);
      toast.success(ids.length === 1 ? 'Data element deleted' : `${ids.length} data elements deleted`);
    } catch (err) {
      toast.error(`Delete failed: ${(err as Error).message}`);
      void reloadDataElements(deSort);
    } finally {
      setDeDeleting(false);
    }
  }

  async function selectSlot(slot: RundownSlot) {
    setSelectedSidebarId(slot.slotId);
    const missing = slotMissing(slot);
    const rec = missing ? null : await ensureTemplate(slot.templateId).catch(() => null);
    const variables = rec?.data.variables ?? [];
    setVarsSelection({
      kind: 'slot',
      rundownId: active?.id ?? '',
      slotId: slot.slotId,
      templateId: slot.templateId,
      dataElementId: slot.dataElementId,
      variables,
      values: buildValuesFromVars(variables, slot.vars),
      missing,
    });
  }

  async function createRundown() {
    const rd = await api.rundowns.create({
      name: `Rundown ${rundowns.length + 1}`,
      channel_id: channelId,
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
      channel_id: channelId,
      slots: src.slots.map((s) => ({ ...s, slotId: createId() })),
    });
    setRundowns((prev) => [rd, ...prev]);
    setActiveId(rd.id);
  }

  async function removeRundown(id: string) {
    await api.rundowns.remove(id);
    const next = rundowns.filter((r) => r.id !== id);
    setRundowns(next);
    if (activeId === id) setActiveId(next[0]?.id ?? null);
  }

  async function onUnifiedDragEnd(event: DragEndEvent) {
    const { active: dragActive, over } = event;
    if (!over) return;
    const activeParsed = parseDragId(String(dragActive.id));
    const overParsed = parseDragId(String(over.id));
    const overId = String(over.id);

    // Rundown list reorder
    if (activeParsed?.kind === 'rundown' && overParsed?.kind === 'rundown') {
      if (dragActive.id === over.id) return;
      const from = rundowns.findIndex((r) => r.id === activeParsed.id);
      const to = rundowns.findIndex((r) => r.id === overParsed.id);
      if (from < 0 || to < 0) return;
      const next = arrayMove(rundowns, from, to);
      setRundowns(next);
      try {
        await api.rundowns.reorder(next.map((r) => r.id), channelId);
      } catch (e) {
        toast.error(`Reorder failed: ${(e as Error).message}`);
      }
      return;
    }

    // Drop template / DE onto slots
    if (activeParsed?.kind === 'template' || activeParsed?.kind === 'dataElement') {
      if (overId !== 'slots-drop' && !overId.startsWith('slot:')) return;
      if (!active) {
        toast.error('Select a rundown first');
        return;
      }
      if (activeParsed.kind === 'template') {
        const t = templates.find((x) => x.id === activeParsed.id);
        if (!t) return;
        const rec = await ensureTemplate(t.id).catch(() => null);
        const vars = rec ? defaultsFromVariables(rec.data.variables) : {};
        const slot: RundownSlot = {
          slotId: createId(),
          templateId: t.id,
          name: t.name,
          vars,
        };
        patchActive((r) => ({ ...r, slots: [...r.slots, slot] }));
      } else {
        const de = deById.get(activeParsed.id);
        if (!de) return;
        const slot: RundownSlot = {
          slotId: createId(),
          templateId: de.templateId,
          dataElementId: de.id,
          name: de.name,
          vars: { ...de.vars },
        };
        patchActive((r) => ({ ...r, slots: [...r.slots, slot] }));
      }
      return;
    }

    // Slot reorder
    if (activeParsed?.kind === 'slot' && overId.startsWith('slot:') && active) {
      const from = active.slots.findIndex((s) => s.slotId === activeParsed.id);
      const to = active.slots.findIndex((s) => `slot:${s.slotId}` === overId);
      if (from < 0 || to < 0 || from === to) return;
      const focusedSlotId = active.slots[focusIdx]?.slotId;
      patchActive((r) => ({ ...r, slots: arrayMove(r.slots, from, to) }));
      if (focusedSlotId) {
        const nextIdx = arrayMove(active.slots, from, to).findIndex((s) => s.slotId === focusedSlotId);
        if (nextIdx >= 0) setFocusIdx(nextIdx);
      }
    }
  }

  async function importRundown(file: File) {
    const text = await file.text();
    const parsed = JSON.parse(text) as { name?: unknown; slots?: unknown };
    const slots = Array.isArray(parsed.slots)
      ? parsed.slots.map((raw, i) => normalizeImportedSlot(raw, i)).filter(Boolean) as RundownSlot[]
      : [];
    const rd = await api.rundowns.create({
      name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : 'Imported rundown',
      channel_id: channelId,
      slots: slots.map((s) => ({ ...s, slotId: createId() })),
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

  const monitorLive = onAir[channelId] ?? [];

  if (!dataLoaded) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <p className="text-[13px] text-ink-muted">Loading control data…</p>
      </div>
    );
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => { void onUnifiedDragEnd(e); }}>
    <div className="flex h-full min-h-0">
      {/* Sidebar */}
      <aside
        className="relative flex min-h-0 shrink-0 flex-col border-r border-border p-2"
        style={{ width: sidebarWidth }}
      >
        <input
          ref={importRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importRundown(f).catch((err) => toast.error(`Import failed: ${(err as Error).message}`));
            e.target.value = '';
          }}
        />
        <div className="mb-2 flex items-center gap-1">
          <Select
            value={sidebarMode}
            onChange={(e) => setSidebarMode(e.target.value as SidebarMode)}
            className="min-w-0 flex-1"
          >
            <option value="rundowns">Rundowns</option>
            <option value="templates">Templates</option>
            <option value="dataElements">DataElements</option>
          </Select>
          {sidebarMode === 'rundowns' && (
            <div className="flex shrink-0 items-center gap-1">
              <button type="button" className="text-ink-faint hover:text-ink" onClick={() => importRef.current?.click()} title="Import">
                <FileUp className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="text-ink-faint hover:text-ink"
                onClick={() => void createRundown().catch((e) => toast.error((e as Error).message))}
                title="Create rundown"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {sidebarMode === 'rundowns' && (
            rundowns.length === 0 ? (
              <div className="px-2 py-6 text-center text-[12px] text-ink-faint">
                No rundowns for this channel.
                <div className="mt-2">
                  <Button size="sm" variant="primary" onClick={() => void createRundown().catch((e) => toast.error((e as Error).message))}>
                    Create rundown
                  </Button>
                </div>
              </div>
            ) : (
              <SortableContext items={rundowns.map((r) => `rd:${r.id}`)} strategy={verticalListSortingStrategy}>
                <div className="space-y-1">
                  {rundowns.map((r) => (
                    <SortableRundownRow
                      key={r.id}
                      rundown={r}
                      active={r.id === activeId}
                      renaming={renamingId === r.id}
                      renameVal={renameVal}
                      canDelete={rundowns.length > 0}
                      onSelect={() => setActiveId(r.id)}
                      onRenameStart={() => { setRenamingId(r.id); setRenameVal(r.name); }}
                      onRenameChange={setRenameVal}
                      onRenameCommit={() => {
                        setRenamingId(null);
                        void api.rundowns.update(r.id, { name: renameVal.trim() || r.name })
                          .then((u) => setRundowns((prev) => prev.map((x) => (x.id === u.id ? u : x))));
                      }}
                      onRenameCancel={() => setRenamingId(null)}
                      onDuplicate={() => void duplicateRundown(r.id).catch((e) => toast.error((e as Error).message))}
                      onExport={() => exportRundown(r)}
                      onRemove={() => void removeRundown(r.id).catch((e) => toast.error((e as Error).message))}
                    />
                  ))}
                </div>
              </SortableContext>
            )
          )}

          {sidebarMode === 'templates' && (
            <div className="space-y-1.5 px-1 pt-1">
              <Select
                value={sidebarFolderId}
                onChange={(e) => setSidebarFolderId(e.target.value)}
                className="w-full"
                aria-label="Template folder"
              >
                <option value={ALL_FOLDER}>&lt;All&gt;</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </Select>
              <div className="space-y-0.5">
                {templatesSorted.map((t) => (
                  <DraggableTemplateRow
                    key={t.id}
                    template={t}
                    selected={selectedSidebarId === t.id && varsSelection.kind === 'template'}
                    onSelect={() => void selectTemplate(t)}
                  />
                ))}
                {templatesSorted.length === 0 && (
                  <p className="px-2 py-6 text-center text-[12px] text-ink-faint">No templates.</p>
                )}
              </div>
            </div>
          )}

          {sidebarMode === 'dataElements' && (
            <>
              <div className="space-y-1.5 px-1 pt-1">
                <Select
                  value={sidebarFolderId}
                  onChange={(e) => {
                    setSidebarFolderId(e.target.value);
                    setSidebarTemplateId(ALL_TEMPLATE);
                  }}
                  className="w-full"
                  aria-label="Data element folder"
                >
                  <option value={ALL_FOLDER}>&lt;All&gt;</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </Select>
                <Select
                  value={sidebarTemplateId}
                  onChange={(e) => setSidebarTemplateId(e.target.value)}
                  className="w-full"
                  aria-label="Data element template"
                >
                  <option value={ALL_TEMPLATE}>&lt;All templates&gt;</option>
                  {templatesSorted.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </Select>
              </div>
              <div className="mb-1 grid grid-cols-[1fr_72px_28px] gap-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                <button
                  type="button"
                  className="text-left hover:text-ink"
                  onClick={() => setDeSort('name')}
                >
                  Name
                </button>
                <button
                  type="button"
                  className="text-right hover:text-ink"
                  onClick={() => setDeSort('updated')}
                >
                  Updated
                </button>
                <span aria-hidden />
              </div>
              <div className="space-y-0.5">
                {filteredDataElements.map((de) => (
                  <DraggableDataElementRow
                    key={de.id}
                    dataElement={de}
                    selected={deSelectedIds.has(de.id)}
                    active={selectedSidebarId === de.id && varsSelection.kind === 'dataElement'}
                    onSelect={(e) => onDataElementClick(de, e)}
                    onDelete={() => requestDeleteDataElements([de.id])}
                  />
                ))}
                {filteredDataElements.length === 0 && (
                  <p className="px-2 py-6 text-center text-[12px] text-ink-faint">No data elements.</p>
                )}
              </div>
            </>
          )}
        </div>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-ew-resize touch-none hover:bg-primary/25 active:bg-primary/40"
          onPointerDown={onSidebarResizeStart}
          onPointerMove={onSidebarResizeMove}
          onPointerUp={onSidebarResizeEnd}
          onPointerCancel={onSidebarResizeEnd}
        />
      </aside>

      {/* Center: transport + slots */}
      <div className="min-h-0 min-w-0 flex-1 overflow-auto border-r border-border p-3">
        {!active ? (
          <p className="p-6 text-center text-[13px] text-ink-muted">Select or create a rundown.</p>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded border border-border bg-surface px-3 py-2">
              <Button size="sm" variant="neutral" disabled={focusIdx === 0} onClick={() => { const i = Math.max(0, focusIdx - 1); setFocusIdx(i); void takeAt(i); }}>PREV</Button>
              <Button size="sm" variant="primary" disabled={active.slots.length === 0 || (active.slots[focusIdx] ? slotMissing(active.slots[focusIdx]) : true)} onClick={() => void takeAt(focusIdx)}>TAKE</Button>
              <Button size="sm" variant="neutral" disabled={focusIdx >= active.slots.length - 1} onClick={() => { const i = Math.min(active.slots.length - 1, focusIdx + 1); setFocusIdx(i); void takeAt(i); }}>NEXT</Button>
              <Button size="sm" variant="ghost" onClick={() => {
                for (const slot of active.slots) if (activeLiveSet.has(slot.slotId)) clearSlot(slot.slotId);
              }}>CLEAR LIVE</Button>
              <span className="tnum rounded border border-border px-2 py-1 text-[12px] text-ink-muted">
                {active.slots.length === 0 ? '0 / 0' : `${focusIdx + 1} / ${active.slots.length}`}
              </span>
            </div>

            <h3 className="mb-2 text-sm font-semibold">{active.name}</h3>

            <SlotsDropZone>
              <SortableContext items={active.slots.map((s) => `slot:${s.slotId}`)} strategy={verticalListSortingStrategy}>
                <div className="space-y-2">
                  {active.slots.map((slot, idx) => {
                    const focused = idx === focusIdx;
                    const live = activeLiveSet.has(slot.slotId);
                    const waitingContinue = live && !!waitingByTemplate.get(slot.templateId);
                    const missing = slotMissing(slot);
                    return (
                      <SortableSlotRow
                        key={slot.slotId}
                        slot={slot}
                        displayName={slotDisplayName(slot)}
                        focused={focused}
                        live={live}
                        waitingContinue={waitingContinue}
                        missing={missing}
                        selected={varsSelection.kind === 'slot' && varsSelection.slotId === slot.slotId}
                        onFocus={() => { setFocusIdx(idx); void selectSlot(slot); }}
                        onRemove={() => patchActive((r) => ({ ...r, slots: r.slots.filter((s) => s.slotId !== slot.slotId) }))}
                        onTake={() => { if (!missing) void takeAt(idx); }}
                        onContinue={() => continueSlot(slot.slotId)}
                        onClear={() => clearSlot(slot.slotId)}
                      />
                    );
                  })}
                  {active.slots.length === 0 && (
                    <div className="rounded border border-dashed border-border px-4 py-8 text-center text-[13px] text-ink-muted">
                      Drop a template or data element here.
                    </div>
                  )}
                </div>
              </SortableContext>
            </SlotsDropZone>
          </>
        )}
      </div>

      {/* Right: preview + on air + variables */}
      <div className="flex w-[380px] shrink-0 min-h-0 flex-col gap-4 overflow-auto p-4">
        {channelId && <ProgramMonitor channelId={channelId} />}
        <div>
          <h3 className="mb-2 text-[12px] font-semibold text-ink-muted">On air ({monitorLive.length})</h3>
          {monitorLive.length === 0 ? (
            <p className="text-[12px] text-ink-faint">Nothing on air.</p>
          ) : (
            <ul className="space-y-1">
              {monitorLive.map((entry) => {
                const tid = entry.templateId;
                const slot = entry.slotId
                  ? active?.slots.find((s) => s.slotId === entry.slotId)
                  : active?.slots.find((s) => s.templateId === tid && ownerByTemplate.get(tid) === s.slotId);
                const label = slot
                  ? (slotMissing(slot) ? { primary: 'NOT FOUND IN DB', secondary: null as string | null } : slotDisplayName(slot))
                  : { primary: templates.find((t) => t.id === tid)?.name ?? tid, secondary: null as string | null };
                return (
                  <li key={`${tid}:${entry.slotId ?? ''}`} className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5">
                    <span className={cn('min-w-0 flex-1', slot && slotMissing(slot) && 'font-semibold text-live')}>
                      <span className="block truncate text-[13px] font-semibold">{label.primary}</span>
                      {label.secondary && (
                        <span className="block truncate text-[11px] text-ink-faint">{label.secondary}</span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => clearSlot(entry.slotId ?? tid)}
                      className="text-ink-faint hover:text-danger"
                      aria-label="Clear"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="flex min-h-[200px] flex-1 flex-col border-t border-border pt-3">
          <ControlVariablesPanel
            selection={varsSelection}
            onChangeValues={(values) => {
              setVarsSelection((prev) => (prev.kind === 'none' ? prev : { ...prev, values }));
            }}
            onClearSelection={() => {
              setVarsSelection({ kind: 'none' });
              setSelectedSidebarId(null);
            }}
            onSlotSaved={(rundownId, slotId, values) => {
              setRundowns((prev) => prev.map((r) => {
                if (r.id !== rundownId) return r;
                return {
                  ...r,
                  slots: r.slots.map((s) => (s.slotId === slotId ? { ...s, vars: values } : s)),
                };
              }));
              const slot = active?.slots.find((s) => s.slotId === slotId);
              if (slot && activeLiveSet.has(slotId)) {
                void ensureTemplate(slot.templateId).then((tpl) => {
                  void updateLive(slotId, buildPayload({ ...slot, vars: values }, tpl.data.variables));
                }).catch(() => undefined);
              }
            }}
            onDataElementsChanged={() => void reloadDataElements(deSort)}
          />
        </div>
      </div>
    </div>

    {deDeleteIds && (
      <div className="fixed inset-0 z-modal grid place-items-center bg-bg/70 px-4 backdrop-blur-sm">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-dataelements-title"
          className="w-full max-w-sm rounded-xl border border-border bg-surface p-5 shadow-2xl"
        >
          <p id="delete-dataelements-title" className="text-sm text-ink">
            {deDeleteIds.length === 1
              ? `Delete "${dataElements.find((d) => d.id === deDeleteIds[0])?.name ?? 'data element'}"? This cannot be undone.`
              : `Delete ${deDeleteIds.length} data elements? This cannot be undone.`}
          </p>
          <p className="mt-2 text-[12px] text-ink-faint">Press Enter to confirm.</p>
          <div className="mt-5 flex justify-end gap-2">
            <Button
              variant="danger"
              disabled={deDeleting}
              onClick={() => { void confirmDeleteDataElements(); }}
            >
              {deDeleting ? 'Deleting…' : 'Delete'}
            </Button>
            <Button
              variant="neutral"
              disabled={deDeleting}
              onClick={() => setDeDeleteIds(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      </div>
    )}
    </DndContext>
  );
}

function SlotsDropZone({ children }: { children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'slots-drop' });
  return (
    <div ref={setNodeRef} className={cn('min-h-[120px] rounded-md', isOver && 'ring-1 ring-primary/50')}>
      {children}
    </div>
  );
}

function DraggableTemplateRow({
  template, selected, onSelect,
}: {
  template: TemplateSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: dragIdTemplate(template.id),
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      style={{ transform: CSS.Translate.toString(transform) }}
      {...attributes}
      {...listeners}
      onClick={onSelect}
      className={cn(
        'flex w-full cursor-grab items-center rounded border px-2 py-1.5 text-left text-[13px]',
        selected ? 'border-primary/60 bg-surface-2' : 'border-transparent hover:bg-surface-2',
        isDragging && 'opacity-60',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{template.name}</span>
    </button>
  );
}

function DraggableDataElementRow({
  dataElement, selected, active, onSelect, onDelete,
}: {
  dataElement: DataElement;
  selected: boolean;
  active: boolean;
  onSelect: (e: React.MouseEvent) => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: dragIdDataElement(dataElement.id),
  });
  const updated = dataElement.updatedAt?.slice(0, 10) ?? '';
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(
        'grid w-full grid-cols-[1fr_72px_28px] items-center gap-1 rounded border px-2 py-1.5 text-[13px]',
        selected || active ? 'border-primary/60 bg-surface-2' : 'border-transparent hover:bg-surface-2',
        isDragging && 'opacity-60',
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        onClick={onSelect}
        className="min-w-0 cursor-grab truncate text-left"
      >
        {dataElement.name}
      </button>
      <button
        type="button"
        onClick={onSelect}
        className="truncate text-right text-[11px] tabular-nums text-ink-faint"
      >
        {updated}
      </button>
      <button
        type="button"
        title="Delete data element"
        aria-label={`Delete ${dataElement.name}`}
        className="grid h-6 w-6 place-items-center text-ink-faint hover:text-danger"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}

function SortableRundownRow({
  rundown,
  active,
  renaming,
  renameVal,
  canDelete,
  onSelect,
  onRenameStart,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onDuplicate,
  onExport,
  onRemove,
}: {
  rundown: Rundown;
  active: boolean;
  renaming: boolean;
  renameVal: string;
  canDelete: boolean;
  onSelect: () => void;
  onRenameStart: () => void;
  onRenameChange: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `rd:${rundown.id}` });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'group rounded border px-2 py-1.5',
        active ? 'border-primary/60 bg-surface-2' : 'border-border bg-surface',
        isDragging && 'opacity-60',
      )}
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="grid h-5 w-4 shrink-0 cursor-grab place-items-center text-ink-faint hover:text-ink"
          aria-label="Drag to reorder rundown"
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="h-3.5 w-3.5" aria-hidden />
        </button>
        <button type="button" className="min-w-0 flex-1 text-left text-[13px] font-medium" onClick={onSelect}>
          {renaming ? (
            <Input
              value={renameVal}
              autoFocus
              onChange={(e) => onRenameChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onRenameCommit();
                if (e.key === 'Escape') onRenameCancel();
              }}
            />
          ) : rundown.name}
        </button>
        <button type="button" className="text-ink-faint hover:text-ink" onClick={onRenameStart}><Pencil className="h-3.5 w-3.5" /></button>
        <button type="button" className="text-ink-faint hover:text-ink" onClick={onDuplicate}><Copy className="h-3.5 w-3.5" /></button>
        <button type="button" className="text-ink-faint hover:text-ink" onClick={onExport}><FileDown className="h-3.5 w-3.5" /></button>
        <button type="button" className="text-ink-faint hover:text-danger" disabled={!canDelete} onClick={onRemove}><Trash2 className="h-3.5 w-3.5" /></button>
      </div>
      <div className="mt-1 pl-5 text-[11px] text-ink-faint">{rundown.slots.length} slots</div>
    </div>
  );
}

function SortableSlotRow({
  slot,
  displayName,
  focused,
  live,
  waitingContinue,
  missing,
  selected,
  onFocus,
  onRemove,
  onTake,
  onContinue,
  onClear,
}: {
  slot: RundownSlot;
  displayName: { primary: string; secondary: string | null };
  focused: boolean;
  live: boolean;
  waitingContinue: boolean;
  missing: boolean;
  selected: boolean;
  onFocus: () => void;
  onRemove: () => void;
  onTake: () => void;
  onContinue: () => void;
  onClear: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `slot:${slot.slotId}` });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'rounded border px-3 py-2',
        selected || focused ? 'border-primary/70 bg-surface-2' : 'border-border bg-surface',
        isDragging && 'opacity-60',
      )}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="grid h-5 w-4 shrink-0 cursor-grab place-items-center text-ink-faint hover:text-ink"
          aria-label="Drag to reorder slot"
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="h-3.5 w-3.5" aria-hidden />
        </button>
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onFocus}>
          <div className={cn('truncate text-sm font-semibold', missing && 'text-live')}>
            {missing ? 'NOT FOUND IN DB' : displayName.primary}
          </div>
          {!missing && displayName.secondary && (
            <div className="truncate text-[11px] text-ink-faint">{displayName.secondary}</div>
          )}
        </button>
        <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-semibold', live ? 'bg-live text-primary-ink' : focused ? 'bg-primary/20 text-primary' : 'bg-surface-2 text-ink-muted')}>
          {live ? 'ON AIR' : focused ? 'NEXT' : 'PENDING'}
        </span>
        <button type="button" className="text-ink-faint hover:text-danger" onClick={onRemove}><Trash2 className="h-3.5 w-3.5" /></button>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            title="Take"
            aria-label="Take"
            disabled={!live && missing}
            className={cn(
              'grid h-8 w-8 place-items-center rounded-md border',
              missing && !live
                ? 'cursor-not-allowed border-border text-ink-faint opacity-40'
                : live
                  ? 'border-border text-ink hover:bg-surface-2'
                  : 'border-primary/50 bg-primary/15 text-primary hover:bg-primary/25',
            )}
            onClick={onTake}
          >
            <ArrowRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Continue"
            aria-label="Continue"
            disabled={!waitingContinue}
            className={cn(
              'grid h-8 w-8 place-items-center rounded-md border',
              waitingContinue
                ? 'border-primary/50 bg-primary/15 text-primary hover:bg-primary/25'
                : 'cursor-not-allowed border-border text-ink-faint opacity-40',
            )}
            onClick={onContinue}
          >
            <ChevronsRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Clear"
            aria-label="Clear"
            disabled={!live}
            className={cn(
              'grid h-8 w-8 place-items-center rounded-md border',
              live
                ? 'border-border text-ink hover:bg-surface-2 hover:text-danger'
                : 'cursor-not-allowed border-border text-ink-faint opacity-40',
            )}
            onClick={onClear}
          >
            <Square className="h-3.5 w-3.5 fill-current" />
          </button>
        </div>
      </div>
    </div>
  );
}

function normalizeImportedSlot(raw: unknown, idx: number): RundownSlot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const slot = raw as Record<string, unknown>;
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
    templateId,
    name,
    vars,
    ...(dataElementId ? { dataElementId } : {}),
  };
}
