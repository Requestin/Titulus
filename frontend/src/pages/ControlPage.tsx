// frontend/src/pages/ControlPage.tsx
//
// Operator control panel (DEVELOPMENT_PROMPT §8.4): per-channel TAKE / UPDATE
// (debounced) / CLEAR / CLEAR ALL over /ws/control, a live program monitor, a
// Browser Source URL for OBS/vMix, and Templates | Rundowns tabs. On load it
// restores on-air state from /api/onair (NFR-1).

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, Check, X, Radio, Trash2 } from 'lucide-react';
import { api, type Channel, type OnAirDetailsSnapshot, type TemplateSummary, type TemplateRecord, type Rundown } from '@/core/api';
import { continueCommand, formatOnAirRow, isWaitingContinue, onAirOwnerLabel, resolveOnAirRows } from '@/control/onAirContinue';
import { useControlWs, type WsStatus } from '@/core/controlWs';
import { prepareForAir } from '@/control/prepareForAir';
import { toast } from '@/core/toast';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/form';
import { cn } from '@/lib/cn';
import { ProgramMonitor } from '@/control/ProgramMonitor';
import { VariableValues } from '@/control/VariableValues';
import { RundownTab } from '@/control/RundownTab';
import { createId } from '@/core/id';

export function ControlPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState<string>('');
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [rundowns, setRundowns] = useState<Rundown[]>([]);
  const [controlDataLoaded, setControlDataLoaded] = useState(false);
  const [onAir, setOnAir] = useState<Record<string, string[]>>({});
  const [onAirDetails, setOnAirDetails] = useState<OnAirDetailsSnapshot | null>(null);
  const [tab, setTab] = useState<'templates' | 'rundowns'>('templates');
  const [rundownMonitorChannel, setRundownMonitorChannel] = useState<string>('');

  const status = useControlWs((s) => s.status);
  const connect = useControlWs((s) => s.connect);
  const send = useControlWs((s) => s.send);

  useEffect(() => { connect(); }, [connect]);

  useEffect(() => {
    (async () => {
      try {
        const [ch, tpl, rd, air, details] = await Promise.all([
          api.channels.list(), api.templates.list(), api.rundowns.list(), api.onair.get(), api.onair.details(),
        ]);
        setChannels(ch);
        setTemplates(tpl);
        setRundowns(rd.map(normalizeRundown));
        setOnAir(air);
        setOnAirDetails(details);
        if (ch.length && !channelId) setChannelId(ch[0].id);
      } catch (e) {
        toast.error(`Failed to load control data: ${(e as Error).message}`);
      } finally {
        setControlDataLoaded(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const live = onAir[channelId] ?? [];
  const monitorChannelId = tab === 'rundowns'
    ? (rundownMonitorChannel || channelId || 'default')
    : (channelId || 'default');
  const monitorLive = onAir[monitorChannelId] ?? [];
  const monitorRows = resolveOnAirRows(onAirDetails, monitorChannelId, monitorLive);

  const markTaken = useCallback((tid: string) => {
    setOnAir((prev) => ({ ...prev, [channelId]: Array.from(new Set([...(prev[channelId] ?? []), tid])) }));
  }, [channelId]);
  const markCleared = useCallback((tid: string) => {
    setOnAir((prev) => ({ ...prev, [channelId]: (prev[channelId] ?? []).filter((x) => x !== tid) }));
  }, [channelId]);

  async function take(rec: TemplateRecord, values: Record<string, string | number>) {
    if (!channelId) { toast.error('Select a channel first'); return; }
    try {
      const prepared = await prepareForAir(rec.data, 'take', values);
      if (prepared.blocked) {
        toast.error(prepared.errors[0]?.message || 'Data pipeline blocked TAKE');
        return;
      }
      const ok = send({
        type: 'take',
        channelId,
        templateId: rec.id,
        template: prepared.template ?? rec.data,
        variables: { ...values, ...prepared.overrides },
      });
      if (!ok) { toast.error('Control WebSocket not connected'); return; }
      markTaken(rec.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Prepare failed');
    }
  }
  function update(templateId: string, values: Record<string, string | number>) {
    send({ type: 'update', channelId, templateId, variables: values });
  }
  function clear(templateId: string) {
    send({ type: 'clear', channelId, templateId });
    markCleared(templateId);
  }
  function clearFromChannel(targetChannelId: string, templateId: string) {
    send({ type: 'clear', channelId: targetChannelId, templateId });
    setOnAir((prev) => ({
      ...prev,
      [targetChannelId]: (prev[targetChannelId] ?? []).filter((x) => x !== templateId),
    }));
  }
  function clearAll() {
    if (!channelId) return;
    send({ type: 'clear', channelId });
    setOnAir((prev) => ({ ...prev, [channelId]: [] }));
  }
  function continueLive(templateId: string) {
    if (!channelId) return;
    send(continueCommand(channelId, templateId));
  }

  useEffect(() => {
    if (!channelId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const [air, details] = await Promise.all([api.onair.get(), api.onair.details()]);
        if (cancelled) return;
        setOnAir(air);
        setOnAirDetails(details);
      } catch {
        // keep last snapshot if the sibling endpoint is briefly unavailable
      }
    };
    const timer = window.setInterval(() => { void poll(); }, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [channelId]);

  const browserSourceUrl = monitorChannelId ? `${location.origin}/channel.html?channel=${monitorChannelId}` : '';

  if (channels.length === 0) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div className="space-y-2">
          <Radio className="mx-auto h-8 w-8 text-ink-faint" aria-hidden />
          <p className="text-sm font-medium">No channels yet</p>
          <p className="text-[13px] text-ink-muted">Create a channel to start putting graphics on air.</p>
          <Link to="/settings" className="inline-block text-primary hover:underline">Go to Settings</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Channel bar */}
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
        <Select value={channelId} onChange={(e) => setChannelId(e.target.value)} className="w-48">
          {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <WsBadge status={status} />
        <div className="ml-auto flex items-center gap-2">
          <BrowserSourceUrl url={browserSourceUrl} />
          {tab === 'templates' && (
            <Button variant="danger" size="sm" onClick={clearAll} disabled={live.length === 0}>
              <Trash2 className="h-4 w-4" aria-hidden /> Clear all
            </Button>
          )}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_380px]">
        {/* Left: tabs */}
        <div className="flex min-w-0 flex-col border-r border-border">
          <div className="flex shrink-0 border-b border-border">
            {(['templates', 'rundowns'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  'px-4 py-2.5 text-sm capitalize transition-colors',
                  tab === t ? 'border-b-2 border-primary text-ink' : 'text-ink-muted hover:text-ink',
                )}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {tab === 'templates'
              ? <TemplatesTab
                  templates={templates}
                  live={live}
                  canContinue={prepId => isWaitingContinue(onAirDetails, channelId, prepId)}
                  onTake={take}
                  onUpdate={update}
                  onClear={clear}
                  onContinue={continueLive}
                />
              : (
                <RundownTab
                  channels={channels}
                  templates={templates}
                  rundowns={rundowns}
                  setRundowns={setRundowns}
                  dataLoaded={controlDataLoaded}
                  onAir={onAir}
                  setOnAir={setOnAir}
                  fallbackChannelId={channelId || 'default'}
                  send={send}
                  onAirDetails={onAirDetails}
                  onPreferredChannelChange={setRundownMonitorChannel}
                />
              )}
          </div>
        </div>

        {/* Right: monitor + on-air */}
        <div className="flex min-h-0 flex-col gap-4 overflow-auto p-4">
          {monitorChannelId && <ProgramMonitor channelId={monitorChannelId} />}
          <div>
            <h3 className="mb-2 text-[12px] font-semibold text-ink-muted">On air ({monitorRows.length})</h3>
            {monitorRows.length === 0 ? (
              <p className="text-[12px] text-ink-faint">Nothing on air.</p>
            ) : (
              <ul className="space-y-1">
                {monitorRows.map((item) => (
                  <li key={item.templateId} className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-[13px]" title={formatOnAirRow(item, displayOnAirName(item.templateId, templates, rundowns), displayOnAirOwner(item, templates, rundowns))}>
                      {formatOnAirRow(item, displayOnAirName(item.templateId, templates, rundowns), displayOnAirOwner(item, templates, rundowns))}
                    </span>
                    <button onClick={() => clearFromChannel(monitorChannelId, item.templateId)} className="text-ink-faint hover:text-danger" aria-label="Clear"><X className="h-4 w-4" /></button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function WsBadge({ status }: { status: WsStatus }) {
  const dot = status === 'connected' ? 'bg-success' : status === 'connecting' ? 'bg-warning' : 'bg-danger';
  return (
    <span className="flex items-center gap-1.5 text-[12px] text-ink-muted">
      <span className={cn('h-2 w-2 rounded-full', dot)} aria-hidden />
      {status}
    </span>
  );
}

function BrowserSourceUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  if (!url) return null;
  return (
    <div className="flex items-center gap-1.5">
      <input
        readOnly
        value={url}
        onFocus={(e) => e.currentTarget.select()}
        className="h-8 w-72 rounded-md border border-border bg-surface-2 px-2 text-[12px] text-ink-muted focus-visible:outline-none"
        title="Browser Source URL for OBS / vMix"
      />
      <button
        onClick={async () => { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        className="grid h-8 w-8 place-items-center rounded-md border border-border text-ink-muted hover:text-ink"
        title="Copy Browser Source URL"
      >
        {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
}

function TemplatesTab({
  templates, live, canContinue, onTake, onUpdate, onClear, onContinue,
}: {
  templates: TemplateSummary[];
  live: string[];
  canContinue: (templateId: string) => boolean;
  onTake: (rec: TemplateRecord, values: Record<string, string | number>) => void;
  onUpdate: (templateId: string, values: Record<string, string | number>) => void;
  onClear: (templateId: string) => void;
  onContinue: (templateId: string) => void;
}) {
  const [prep, setPrep] = useState<TemplateRecord | null>(null);
  const [values, setValues] = useState<Record<string, string | number>>({});
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function loadPrep(id: string) {
    try {
      const rec = await api.templates.get(id);
      setPrep(rec);
      const init: Record<string, string | number> = {};
      for (const v of rec.data.variables) init[v.id] = v.defaultValue;
      setValues(init);
    } catch (e) {
      toast.error(`Failed to load template: ${(e as Error).message}`);
    }
  }

  function setValue(varId: string, v: string | number) {
    setValues((prev) => {
      const next = { ...prev, [varId]: v };
      if (prep && live.includes(prep.id)) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => onUpdate(prep.id, next), 400);
      }
      return next;
    });
  }

  return (
    <div className="grid h-full grid-cols-[1fr_300px]">
      <div className="overflow-auto p-3">
        {templates.length === 0 ? (
          <p className="p-6 text-center text-[13px] text-ink-faint">No templates. Create one in Templates.</p>
        ) : (
          <ul className="space-y-1">
            {templates.map((t) => {
              const isLive = live.includes(t.id);
              return (
                <li key={t.id}>
                  <button
                    onClick={() => loadPrep(t.id)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-[13px] transition-colors',
                      prep?.id === t.id ? 'border-primary bg-primary/10' : 'border-border bg-surface hover:border-ink-faint',
                    )}
                  >
                    {isLive && <span className="h-2 w-2 shrink-0 rounded-full bg-live" aria-label="on air" />}
                    <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex flex-col border-l border-border">
        {!prep ? (
          <p className="p-4 text-[13px] text-ink-faint">Select a template to prepare.</p>
        ) : (
          <>
            <div className="border-b border-border p-3">
              <div className="truncate text-sm font-medium">{prep.name}</div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3">
              <VariableValues variables={prep.data.variables} values={values} onChange={setValue} />
            </div>
            <div className="grid grid-cols-4 gap-2 border-t border-border p-3">
              <Button variant="danger" onClick={() => onTake(prep, values)}>TAKE</Button>
              <Button variant="neutral" onClick={() => onUpdate(prep.id, values)} disabled={!live.includes(prep.id)}>UPDATE</Button>
              <Button variant="neutral" onClick={() => onClear(prep.id)} disabled={!live.includes(prep.id)}>CLEAR</Button>
              <Button variant="neutral" onClick={() => onContinue(prep.id)} disabled={!canContinue(prep.id)}>CONTINUE</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function normalizeRundown(rundown: Rundown): Rundown {
  const slots = Array.isArray(rundown.slots) ? rundown.slots : [];
  return {
    ...rundown,
    slots: slots.map((slot, idx) => {
      const vars = slot.vars ?? slot.variables ?? {};
      const name = slot.name ?? slot.label ?? `Slot ${idx + 1}`;
      return {
        ...slot,
        slotId: slot.slotId ?? slot.id ?? createId(),
        name,
        vars,
      };
    }),
  };
}

function displayOnAirOwner(item: import('@/core/api').OnAirDetailsItem, templates: TemplateSummary[], rundowns: Rundown[]): string {
  if (templates.some((template) => template.id === item.templateId)) return 'template';
  for (const rundown of rundowns) {
    const slot = rundown.slots.find((entry) => entry.slotId === item.templateId || entry.slotId === item.slotId);
    if (slot) return `slot ${slot.slotId}`;
  }
  return onAirOwnerLabel(item);
}

function displayOnAirName(id: string, templates: TemplateSummary[], rundowns: Rundown[]): string {
  const tpl = templates.find((t) => t.id === id);
  if (tpl) return tpl.name;
  for (const rundown of rundowns) {
    const slot = rundown.slots.find((s) => s.slotId === id);
    if (slot) return `${rundown.name} / ${slot.name}`;
  }
  return id;
}
