import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Variable } from '@runtime';
import {
  Plus, FileUp, FileDown, Copy, Trash2, Pencil, Check, ChevronDown, ChevronRight, ArrowUp, ArrowDown,
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
import { MamPicker } from '@/media/MamPicker';
import { prepareForAir } from '@/control/prepareForAir';
import { continueCommand, isWaitingContinue } from '@/control/onAirContinue';
import { Button } from '@/components/ui/Button';
import { Field, Input, NumberInput, ColorInput, Select } from '@/components/ui/form';
import { MediaUploadButton } from '@/editor/MediaUploadButton';
import { cn } from '@/lib/cn';
import { toast } from '@/core/toast';
import { createId } from '@/core/id';

type SendControl = (cmd: {
  type: 'take' | 'update' | 'clear' | 'continue';
  channelId: string;
  templateId?: string;
  template?: unknown;
  variables?: Record<string, string | number>;
}) => boolean;

export function RundownTab({
  channels,
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
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [bootstrapping, setBootstrapping] = useState(false);
  const bootstrapAttempted = useRef(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [cache, setCache] = useState<Record<string, TemplateRecord>>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveUpdateTimers = useRef<Record<string, ReturnType<typeof setTimeout> | undefined>>({});
  const importRef = useRef<HTMLInputElement>(null);

  const active = useMemo(() => rundowns.find((r) => r.id === activeId) ?? null, [rundowns, activeId]);
  const channelId = active?.channel_id || fallbackChannelId || 'default';
  const channelLiveSet = new Set(onAir[channelId] ?? []);
  const activeLiveSet = new Set((active?.slots ?? []).filter((s) => channelLiveSet.has(s.slotId)).map((s) => s.slotId));

  useEffect(() => {
    if (!activeId && rundowns.length) setActiveId(rundowns[0].id);
    if (activeId && !rundowns.some((r) => r.id === activeId)) setActiveId(rundowns[0]?.id ?? null);
  }, [rundowns, activeId]);

  useEffect(() => {
    if (!dataLoaded || rundowns.length > 0 || bootstrapAttempted.current) return;
    bootstrapAttempted.current = true;
    setBootstrapping(true);
    void api.rundowns.create({ name: 'Rundown 1', slots: [] })
      .then((rd) => {
        setRundowns([rd]);
        setActiveId(rd.id);
      })
      .catch((e) => {
        bootstrapAttempted.current = false;
        toast.error(`Failed to create default rundown: ${(e as Error).message}`);
      })
      .finally(() => setBootstrapping(false));
  }, [dataLoaded, rundowns.length, setRundowns]);

  useEffect(() => {
    const max = Math.max(0, (active?.slots.length ?? 1) - 1);
    setFocusIdx((i) => Math.min(i, max));
  }, [active?.slots.length]);

  useEffect(() => onPreferredChannelChange?.(channelId), [channelId, onPreferredChannelChange]);

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
    const onKey = (e: KeyboardEvent) => {
      if (!active || active.slots.length === 0) return;
      const tag = (e.target as HTMLElement | null)?.tagName || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusIdx((i) => Math.min(i + 1, active.slots.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === ' ') {
        e.preventDefault();
        void takeAt(focusIdx, true);
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        const s = active.slots[focusIdx];
        if (s && activeLiveSet.has(s.slotId)) clearSlot(s.slotId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, focusIdx, activeLiveSet]);

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

  async function takeAt(index: number, advanceFocus = false) {
    if (!active) return;
    const slot = active.slots[index];
    if (!slot) return;
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
    if (advanceFocus) setFocusIdx((i) => Math.min(i + 1, active.slots.length - 1));
  }

  function clearSlot(slotId: string) {
    const ok = send({ type: 'clear', channelId, templateId: slotId });
    if (!ok) return toast.error('Control socket disconnected');
    patchOnAir(channelId, (cur) => cur.filter((id) => id !== slotId));
  }

  async function updateLive(slotId: string, vars: Record<string, string | number>) {
    if (!activeLiveSet.has(slotId)) return;
    const ok = send({ type: 'update', channelId, templateId: slotId, variables: vars });
    if (!ok) toast.error('Control socket disconnected');
  }

  function updateSlotVar(slotId: string, varId: string, value: string | number) {
    if (!active) return;
    const slot = active.slots.find((s) => s.slotId === slotId);
    if (!slot) return;
    const nextVars = { ...slot.vars, [varId]: value };
    patchActive((r) => ({ ...r, slots: r.slots.map((s) => (s.slotId === slotId ? { ...s, vars: nextVars } : s)) }));
    const timer = liveUpdateTimers.current[slotId];
    if (timer) clearTimeout(timer);
    liveUpdateTimers.current[slotId] = setTimeout(async () => {
      const tpl = await ensureTemplate(slot.templateId).catch(() => null);
      if (!tpl) return;
      void updateLive(slotId, buildPayload({ ...slot, vars: nextVars }, tpl.data.variables));
    }, 300);
  }

  async function createRundown() {
    const rd = await api.rundowns.create({ name: `Rundown ${rundowns.length + 1}`, slots: [] });
    setRundowns((prev) => [rd, ...prev]);
    setActiveId(rd.id);
  }

  async function duplicateRundown(id: string) {
    const src = rundowns.find((r) => r.id === id);
    if (!src) return;
    const rd = await api.rundowns.create({
      name: `${src.name} (copy)`,
      channel_id: src.channel_id,
      slots: src.slots.map((s) => ({ ...s, slotId: createId() })),
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
    const slots = Array.isArray(parsed.slots) ? parsed.slots.map((raw, i) => normalizeImportedSlot(raw, i)).filter(Boolean) as RundownSlot[] : [];
    const rd = await api.rundowns.create({
      name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : 'Imported rundown',
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

  function moveSlot(slotId: string, dir: -1 | 1) {
    if (!active) return;
    const idx = active.slots.findIndex((s) => s.slotId === slotId);
    const to = idx + dir;
    if (idx < 0 || to < 0 || to >= active.slots.length) return;
    patchActive((r) => {
      const next = [...r.slots];
      const [item] = next.splice(idx, 1);
      next.splice(to, 0, item);
      return { ...r, slots: next };
    });
  }

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

  return (
    <div className="grid h-full grid-cols-[250px_1fr]">
      <aside className="border-r border-border p-2">
        <input ref={importRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importRundown(f).catch((err) => toast.error(`Import failed: ${(err as Error).message}`));
          e.target.value = '';
        }} />
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[12px] font-semibold text-ink-muted">Rundowns</span>
          <div className="flex items-center gap-1">
            <button className="text-ink-faint hover:text-ink" onClick={() => importRef.current?.click()}><FileUp className="h-4 w-4" /></button>
            <button className="text-ink-faint hover:text-ink" onClick={() => void createRundown().catch((e) => toast.error((e as Error).message))}><Plus className="h-4 w-4" /></button>
          </div>
        </div>
        <div className="space-y-1">
          {rundowns.map((r, idx) => (
            <div key={r.id} className={cn('rounded border px-2 py-1.5', r.id === activeId ? 'border-primary/60 bg-surface-2' : 'border-border bg-surface')}>
              <div className="flex items-center gap-1">
                <button className="min-w-0 flex-1 text-left text-[13px] font-medium" onClick={() => setActiveId(r.id)}>
                  {renamingId === r.id ? <Input value={renameVal} autoFocus onChange={(e) => setRenameVal(e.target.value)} onKeyDown={(e) => {
                    if (e.key === 'Enter') { setRenamingId(null); void api.rundowns.update(r.id, { name: renameVal.trim() || r.name }).then((u) => setRundowns((prev) => prev.map((x) => x.id === u.id ? u : x))); }
                    if (e.key === 'Escape') setRenamingId(null);
                  }} /> : r.name}
                </button>
                <button className="text-ink-faint hover:text-ink" onClick={() => void moveRundown(r.id, -1)} disabled={idx === 0}><ArrowUp className="h-3.5 w-3.5" /></button>
                <button className="text-ink-faint hover:text-ink" onClick={() => void moveRundown(r.id, 1)} disabled={idx === rundowns.length - 1}><ArrowDown className="h-3.5 w-3.5" /></button>
                <button className="text-ink-faint hover:text-ink" onClick={() => { setRenamingId(r.id); setRenameVal(r.name); }}><Pencil className="h-3.5 w-3.5" /></button>
                <button className="text-ink-faint hover:text-ink" onClick={() => void duplicateRundown(r.id).catch((e) => toast.error((e as Error).message))}><Copy className="h-3.5 w-3.5" /></button>
                <button className="text-ink-faint hover:text-ink" onClick={() => exportRundown(r)}><FileDown className="h-3.5 w-3.5" /></button>
                <button className="text-ink-faint hover:text-danger" disabled={rundowns.length <= 1} onClick={() => void removeRundown(r.id).catch((e) => toast.error((e as Error).message))}><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
              <div className="mt-1 text-[11px] text-ink-faint">{r.slots.length} slots</div>
            </div>
          ))}
        </div>
      </aside>

      <div className="min-h-0 overflow-auto p-3">
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded border border-border bg-surface px-3 py-2">
          <Button size="sm" variant="neutral" disabled={focusIdx === 0} onClick={() => { const i = Math.max(0, focusIdx - 1); setFocusIdx(i); void takeAt(i); }}>PREV</Button>
          <Button size="sm" variant="primary" disabled={active.slots.length === 0} onClick={() => void takeAt(focusIdx, true)}>TAKE</Button>
          <Button
            size="sm"
            variant="neutral"
            disabled={!active.slots[focusIdx] || !isWaitingContinue(onAirDetails, channelId, active.slots[focusIdx].slotId)}
            onClick={() => {
              const slot = active.slots[focusIdx];
              if (slot) send(continueCommand(channelId, slot.slotId));
            }}
          >CONTINUE</Button>
          <Button size="sm" variant="neutral" disabled={focusIdx >= active.slots.length - 1} onClick={() => { const i = Math.min(active.slots.length - 1, focusIdx + 1); setFocusIdx(i); void takeAt(i); }}>NEXT</Button>
          <Button size="sm" variant="ghost" onClick={() => {
            for (const slot of active.slots) if (activeLiveSet.has(slot.slotId)) clearSlot(slot.slotId);
          }}>CLEAR LIVE</Button>
          <span className="tnum rounded border border-border px-2 py-1 text-[12px] text-ink-muted">
            {active.slots.length === 0 ? '0 / 0' : `${focusIdx + 1} / ${active.slots.length}`}
          </span>
          <div className="min-w-[180px]">
            <Select value={active.channel_id ?? ''} onChange={(e) => patchActive((r) => ({ ...r, channel_id: e.target.value || null }))}>
              <option value="">Default channel ({fallbackChannelId || 'default'})</option>
              {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
        </div>

        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">{active.name}</h3>
          <div className="relative">
            <Button size="sm" variant="neutral" onClick={() => setShowAdd((v) => !v)}><Plus className="h-4 w-4" /> Add slot</Button>
            {showAdd && (
              <div className="absolute right-0 z-20 mt-1 max-h-64 w-72 overflow-auto rounded border border-border bg-surface p-1 shadow-lg">
                {templates.map((t) => (
                  <button
                    key={t.id}
                    className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[12px] hover:bg-surface-2"
                    onClick={() => {
                      patchActive((r) => ({ ...r, slots: [...r.slots, { slotId: createId(), templateId: t.id, name: t.name, vars: {} }] }));
                      setShowAdd(false);
                    }}
                  >
                    <span className="truncate">{t.name}</span>
                    <span className="text-[11px] text-ink-faint">{t.id.slice(0, 8)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-2">
          {active.slots.map((slot, idx) => {
            const focused = idx === focusIdx;
            const live = activeLiveSet.has(slot.slotId);
            const tpl = cache[slot.templateId];
            return (
              <div key={slot.slotId} id={`rd-slot-${slot.slotId}`} className={cn('rounded border px-3 py-2', focused ? 'border-primary/70 bg-surface-2' : 'border-border bg-surface')}>
                <div className="flex items-center gap-2">
                  <button className="text-ink-faint hover:text-ink" onClick={() => setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(slot.slotId)) next.delete(slot.slotId); else next.add(slot.slotId);
                    return next;
                  })}>
                    {expanded.has(slot.slotId) ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </button>
                  <button className="min-w-0 flex-1 text-left" onClick={() => setFocusIdx(idx)}>
                    <div className="truncate text-sm font-medium">{slot.name}</div>
                    <div className="truncate text-[11px] text-ink-faint">{templates.find((t) => t.id === slot.templateId)?.name ?? slot.templateId}</div>
                  </button>
                  <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-semibold', live ? 'bg-live text-primary-ink' : focused ? 'bg-primary/20 text-primary' : 'bg-surface-2 text-ink-muted')}>
                    {live ? 'ON AIR' : focused ? 'NEXT' : 'PENDING'}
                  </span>
                  <button className="text-ink-faint hover:text-ink" onClick={() => void moveSlot(slot.slotId, -1)} disabled={idx === 0}><ArrowUp className="h-3.5 w-3.5" /></button>
                  <button className="text-ink-faint hover:text-ink" onClick={() => void moveSlot(slot.slotId, 1)} disabled={idx === active.slots.length - 1}><ArrowDown className="h-3.5 w-3.5" /></button>
                  <button className="text-ink-faint hover:text-danger" onClick={() => patchActive((r) => ({ ...r, slots: r.slots.filter((s) => s.slotId !== slot.slotId) }))}><Trash2 className="h-3.5 w-3.5" /></button>
                  <Button size="sm" variant={live ? 'neutral' : 'danger'} onClick={() => live ? clearSlot(slot.slotId) : void takeAt(idx, true)}>
                    {live ? 'CLEAR' : 'TAKE'}
                  </Button>
                </div>
                {expanded.has(slot.slotId) && (
                  <div className="mt-2 space-y-2 border-t border-border pt-2">
                    <Field label="Slot name">
                      <Input value={slot.name} onChange={(e) => patchActive((r) => ({ ...r, slots: r.slots.map((s) => s.slotId === slot.slotId ? { ...s, name: e.target.value } : s) }))} />
                    </Field>
                    <Field label="Slot ID">
                      <Input value={slot.slotId} readOnly />
                    </Field>
                    <Field label="Data element">
                      <Select
                        value={slot.dataElementId ?? ''}
                        onChange={(e) => patchActive((r) => ({
                          ...r,
                          slots: r.slots.map((s) => s.slotId === slot.slotId
                            ? { ...s, dataElementId: e.target.value || undefined }
                            : s),
                        }))}
                      >
                        <option value="">None</option>
                        {dataElements.filter((item) => item.templateId === slot.templateId).map((item) => (
                          <option key={item.id} value={item.id}>{item.name}</option>
                        ))}
                      </Select>
                    </Field>
                    <Button size="sm" variant="ghost" onClick={() => {
                      if (cache[slot.templateId]) return;
                      void ensureTemplate(slot.templateId).catch((e) => toast.error((e as Error).message));
                    }}>
                      {tpl ? <Check className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
                      {tpl ? 'Template loaded' : 'Load variables'}
                    </Button>
                    {tpl && (
                      <SlotVars
                        varsDef={tpl.data.variables}
                        values={buildPayload(slot, tpl.data.variables)}
                        onChange={(varId, value) => updateSlotVar(slot.slotId, varId, value)}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {active.slots.length === 0 && <div className="rounded border border-dashed border-border px-4 py-8 text-center text-[13px] text-ink-muted">No slots yet. Add a template slot to start rundown playout.</div>}
        </div>
      </div>
    </div>
  );
}

function SlotVars({
  varsDef,
  values,
  onChange,
}: {
  varsDef: Variable[];
  values: Record<string, string | number>;
  onChange: (id: string, value: string | number) => void;
}) {
  if (varsDef.length === 0) return <p className="text-[12px] text-ink-faint">Template has no variables.</p>;
  return (
    <div className="space-y-2">
      {varsDef.map((v) => (
        <Field key={v.id} label={v.label || v.name}>
          {v.type === 'number' ? (
            <NumberInput
              value={Number(values[v.id] ?? 0)}
              aria-label={v.label || v.name}
              onChange={(n) => onChange(v.id, n)}
            />
          ) : v.type === 'color' ? (
            <ColorInput value={String(values[v.id] ?? '#ffffff')} onChange={(c) => onChange(v.id, c)} />
          ) : v.type === 'image' || v.type === 'video' ? (
            <div className="space-y-1">
              <Input value={String(values[v.id] ?? '')} onChange={(e) => onChange(v.id, e.target.value)} />
              <MediaUploadButton
                accept={v.type === 'video' ? 'video/*' : 'image/*'}
                onUploaded={(url) => onChange(v.id, url)}
                label={v.type === 'video' ? 'Upload video' : 'Upload image'}
              />
              <MamPicker onPick={(token) => onChange(v.id, token)} accept={v.type === 'video' ? 'video/*' : 'image/*'} />
            </div>
          ) : (
            <Input value={String(values[v.id] ?? '')} onChange={(e) => onChange(v.id, e.target.value)} />
          )}
        </Field>
      ))}
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
  return {
    slotId: typeof slot.slotId === 'string' && slot.slotId.trim() ? slot.slotId.trim() : createId(),
    templateId,
    name,
    vars,
  };
}

function flattenPayload(payload: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (typeof value === 'string' || typeof value === 'number') out[key] = value;
  }
  return out;
}
