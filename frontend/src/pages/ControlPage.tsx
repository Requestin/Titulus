// frontend/src/pages/ControlPage.tsx
//
// Operator control panel: channel bar, left nav (Rundown | Templates | Data),
// center rundown editor, right monitor + inspector.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Copy, Check, X, Radio, Trash2, Plus, FileUp, FileDown, Pencil, ArrowUp, ArrowDown,
} from 'lucide-react';
import {
  api,
  type Channel,
  type DataElement,
  type OnAirDetailsSnapshot,
  type TemplateFolder,
  type TemplateSummary,
  type Rundown,
} from '@/core/api';
import { formatOnAirRow, onAirOwnerLabel, resolveOnAirRows } from '@/control/onAirContinue';
import {
  ControlItemInspector,
  type InspectorTarget,
} from '@/control/ControlItemInspector';
import {
  foldersVisibleInControl,
  templatesVisibleInControl,
} from '@/control/visibleControlTemplates';
import {
  readHideAllInControl,
  readHideUnassignedInControl,
  readLastRundownId,
  writeLastRundownId,
} from '@/control/controlFolderPrefs';
import {
  MIME_DATA_ELEMENT,
  MIME_TEMPLATE,
  RundownTab,
} from '@/control/RundownTab';
import { useControlWs, type WsStatus } from '@/core/controlWs';
import { toast } from '@/core/toast';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/form';
import { cn } from '@/lib/cn';
import { ProgramMonitor } from '@/control/ProgramMonitor';
import { createId } from '@/core/id';

type NavTab = 'rundowns' | 'templates' | 'data';

export function ControlPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState<string>('');
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [folders, setFolders] = useState<TemplateFolder[]>([]);
  const [dataElements, setDataElements] = useState<DataElement[]>([]);
  const [rundowns, setRundowns] = useState<Rundown[]>([]);
  const [controlDataLoaded, setControlDataLoaded] = useState(false);
  const [onAir, setOnAir] = useState<Record<string, string[]>>({});
  const [onAirDetails, setOnAirDetails] = useState<OnAirDetailsSnapshot | null>(null);
  const [tab, setTab] = useState<NavTab>('rundowns');
  const [rundownMonitorChannel, setRundownMonitorChannel] = useState<string>('');
  const [selectedRundownId, setSelectedRundownId] = useState<string | null>(null);
  const [inspectorTarget, setInspectorTarget] = useState<InspectorTarget | null>(null);
  const [hideAll, setHideAll] = useState(readHideAllInControl);
  const [hideUnassigned, setHideUnassigned] = useState(readHideUnassignedInControl);
  const [folderFilter, setFolderFilter] = useState<string>('all');
  const [dataFolderFilter, setDataFolderFilter] = useState<string>('all');
  const [dataTemplateFilter, setDataTemplateFilter] = useState<string>('all');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const importRef = useRef<HTMLInputElement>(null);

  const status = useControlWs((s) => s.status);
  const connect = useControlWs((s) => s.connect);
  const send = useControlWs((s) => s.send);

  useEffect(() => { connect(); }, [connect]);

  useEffect(() => {
    (async () => {
      try {
        const [ch, tpl, folderRows, deRows, rd, air, details] = await Promise.all([
          api.channels.list(),
          api.templates.list(),
          api.templateFolders.list(),
          api.dataElements.list(),
          api.rundowns.list(),
          api.onair.get(),
          api.onair.details(),
        ]);
        setChannels(ch);
        setFolders(folderRows);
        setDataElements(deRows);
        setTemplates(tpl);
        const normalized = rd.map(normalizeRundown);
        setRundowns(normalized);
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

  // Refresh hide prefs when returning to the page (Templates page may change them).
  useEffect(() => {
    const sync = () => {
      setHideAll(readHideAllInControl());
      setHideUnassigned(readHideUnassignedInControl());
    };
    window.addEventListener('focus', sync);
    sync();
    return () => window.removeEventListener('focus', sync);
  }, []);

  const channelRundowns = useMemo(
    () => rundowns.filter((r) => r.channel_id === channelId || r.channel_id == null),
    [rundowns, channelId],
  );

  useEffect(() => {
    if (!channelId) return;
    const last = readLastRundownId(channelId);
    const preferred = (last && channelRundowns.some((r) => r.id === last))
      ? last
      : (channelRundowns[0]?.id ?? null);
    setSelectedRundownId((cur) => {
      if (cur && channelRundowns.some((r) => r.id === cur)) return cur;
      return preferred;
    });
  }, [channelId, channelRundowns]);

  useEffect(() => {
    if (channelId && selectedRundownId) writeLastRundownId(channelId, selectedRundownId);
  }, [channelId, selectedRundownId]);

  const visibleFolders = useMemo(() => foldersVisibleInControl(folders), [folders]);
  const visibleTemplates = useMemo(
    () => templatesVisibleInControl(templates, folders, { hideAll, hideUnassigned }),
    [templates, folders, hideAll, hideUnassigned],
  );

  const folderSelectOptions = useMemo(() => {
    const opts: Array<{ value: string; label: string }> = [];
    if (!hideAll) opts.push({ value: 'all', label: 'All' });
    if (!hideUnassigned) opts.push({ value: 'unassigned', label: 'Unassigned' });
    for (const folder of visibleFolders) opts.push({ value: folder.id, label: folder.name });
    return opts;
  }, [hideAll, hideUnassigned, visibleFolders]);

  useEffect(() => {
    if (folderSelectOptions.length === 0) return;
    if (!folderSelectOptions.some((o) => o.value === folderFilter)) {
      setFolderFilter(folderSelectOptions[0].value);
    }
    if (!folderSelectOptions.some((o) => o.value === dataFolderFilter)) {
      setDataFolderFilter(folderSelectOptions[0].value);
    }
  }, [folderSelectOptions, folderFilter, dataFolderFilter]);

  const templatesInFolder = useCallback((filter: string) => {
    if (filter === 'all') return visibleTemplates;
    if (filter === 'unassigned') return visibleTemplates.filter((t) => !t.folder_id);
    return visibleTemplates.filter((t) => t.folder_id === filter);
  }, [visibleTemplates]);

  const templatesForTemplatesTab = templatesInFolder(folderFilter);
  const templatesForDataTab = templatesInFolder(dataFolderFilter);

  useEffect(() => {
    if (dataTemplateFilter === 'all') return;
    if (!templatesForDataTab.some((t) => t.id === dataTemplateFilter)) {
      setDataTemplateFilter('all');
    }
  }, [templatesForDataTab, dataTemplateFilter]);

  const dataElementsForList = useMemo(() => {
    if (dataTemplateFilter === 'all') {
      const ids = new Set(templatesForDataTab.map((t) => t.id));
      return dataElements.filter((de) => ids.has(de.templateId));
    }
    return dataElements.filter((de) => de.templateId === dataTemplateFilter);
  }, [dataElements, dataTemplateFilter, templatesForDataTab]);

  const live = onAir[channelId] ?? [];
  const monitorChannelId = channelId || rundownMonitorChannel || 'default';
  const monitorLive = onAir[monitorChannelId] ?? [];
  const monitorRows = resolveOnAirRows(onAirDetails, monitorChannelId, monitorLive);

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

  async function createRundown() {
    if (!channelId) return toast.error('Select a channel first');
    const rd = await api.rundowns.create({
      name: `Rundown ${channelRundowns.length + 1}`,
      channel_id: channelId,
      slots: [],
    });
    setRundowns((prev) => [normalizeRundown(rd), ...prev]);
    setSelectedRundownId(rd.id);
  }

  async function duplicateRundown(id: string) {
    const src = rundowns.find((r) => r.id === id);
    if (!src || !channelId) return;
    const rd = await api.rundowns.create({
      name: `${src.name} (copy)`,
      channel_id: channelId,
      slots: src.slots.map((s) => ({
        ...s,
        slotId: createId(),
        children: s.children?.map((c) => ({ ...c, slotId: createId() })),
      })),
    });
    setRundowns((prev) => [normalizeRundown(rd), ...prev]);
    setSelectedRundownId(rd.id);
  }

  async function removeRundown(id: string) {
    await api.rundowns.remove(id);
    const next = rundowns.filter((r) => r.id !== id);
    setRundowns(next);
    if (selectedRundownId === id) {
      setSelectedRundownId(next.find((r) => r.channel_id === channelId)?.id ?? null);
    }
  }

  async function moveRundown(id: string, dir: -1 | 1) {
    const idx = channelRundowns.findIndex((r) => r.id === id);
    const to = idx + dir;
    if (idx < 0 || to < 0 || to >= channelRundowns.length) return;
    const nextChannel = [...channelRundowns];
    const [item] = nextChannel.splice(idx, 1);
    nextChannel.splice(to, 0, item);
    const others = rundowns.filter((r) => r.channel_id !== channelId);
    const next = [...nextChannel, ...others];
    setRundowns(next);
    await api.rundowns.reorder(next.map((r) => r.id));
  }

  async function importRundown(file: File) {
    if (!channelId) return toast.error('Select a channel first');
    const text = await file.text();
    const parsed = JSON.parse(text) as { name?: unknown; slots?: unknown };
    const slots = Array.isArray(parsed.slots) ? parsed.slots : [];
    const rd = await api.rundowns.create({
      name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : 'Imported rundown',
      channel_id: channelId,
      slots: slots as Rundown['slots'],
    });
    setRundowns((prev) => [normalizeRundown(rd), ...prev]);
    setSelectedRundownId(rd.id);
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
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
        <Select value={channelId} onChange={(e) => setChannelId(e.target.value)} className="w-48">
          {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <WsBadge status={status} />
        <div className="ml-auto flex items-center gap-2">
          <BrowserSourceUrl url={browserSourceUrl} />
          <Button variant="danger" size="sm" onClick={clearAll} disabled={live.length === 0}>
            <Trash2 className="h-4 w-4" aria-hidden /> Clear all
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)_360px]">
        {/* Left: nav + lists */}
        <div className="flex min-h-0 flex-col border-r border-border">
          <div className="flex shrink-0 flex-col border-b border-border p-2">
            {([
              ['rundowns', 'Rundown'],
              ['templates', 'Templates'],
              ['data', 'Data'],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setTab(id);
                  if (id === 'data') setDataTemplateFilter('all');
                }}
                className={cn(
                  'rounded-md px-3 py-2 text-left text-sm transition-colors',
                  tab === id ? 'bg-primary/15 text-ink font-medium' : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {tab === 'rundowns' && (
              <>
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
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Rundowns</span>
                  <div className="flex items-center gap-1">
                    <button type="button" className="text-ink-faint hover:text-ink" onClick={() => importRef.current?.click()} title="Import">
                      <FileUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      className="text-ink-faint hover:text-ink"
                      title="New rundown"
                      onClick={() => void createRundown().catch((e) => toast.error((e as Error).message))}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <div className="space-y-1">
                  {channelRundowns.map((r, idx) => (
                    <div
                      key={r.id}
                      className={cn(
                        'rounded border px-2 py-1.5',
                        r.id === selectedRundownId ? 'border-primary/60 bg-surface-2' : 'border-border bg-surface',
                      )}
                    >
                      <div className="flex items-center gap-0.5">
                        <button
                          type="button"
                          className="min-w-0 flex-1 truncate text-left text-[13px] font-medium"
                          onClick={() => setSelectedRundownId(r.id)}
                        >
                          {renamingId === r.id ? (
                            <Input
                              value={renameVal}
                              autoFocus
                              onChange={(e) => setRenameVal(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  setRenamingId(null);
                                  void api.rundowns.update(r.id, { name: renameVal.trim() || r.name }).then((u) => {
                                    setRundowns((prev) => prev.map((x) => (x.id === u.id ? normalizeRundown(u) : x)));
                                  });
                                }
                                if (e.key === 'Escape') setRenamingId(null);
                              }}
                            />
                          ) : r.name}
                        </button>
                        <button type="button" className="text-ink-faint hover:text-ink" disabled={idx === 0} onClick={() => void moveRundown(r.id, -1)}>
                          <ArrowUp className="h-3 w-3" />
                        </button>
                        <button type="button" className="text-ink-faint hover:text-ink" disabled={idx === channelRundowns.length - 1} onClick={() => void moveRundown(r.id, 1)}>
                          <ArrowDown className="h-3 w-3" />
                        </button>
                        <button type="button" className="text-ink-faint hover:text-ink" onClick={() => { setRenamingId(r.id); setRenameVal(r.name); }}>
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button type="button" className="text-ink-faint hover:text-ink" onClick={() => void duplicateRundown(r.id).catch((e) => toast.error((e as Error).message))}>
                          <Copy className="h-3 w-3" />
                        </button>
                        <button type="button" className="text-ink-faint hover:text-ink" onClick={() => exportRundown(r)}>
                          <FileDown className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          className="text-ink-faint hover:text-danger"
                          disabled={channelRundowns.length === 0}
                          onClick={() => void removeRundown(r.id).catch((e) => toast.error((e as Error).message))}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                      <div className="mt-0.5 text-[11px] text-ink-faint">{r.slots.length} slots</div>
                    </div>
                  ))}
                  {channelRundowns.length === 0 && (
                    <p className="px-1 py-4 text-center text-[12px] text-ink-faint">No rundowns for this channel</p>
                  )}
                </div>
              </>
            )}

            {tab === 'templates' && (
              <div className="space-y-2">
                <label className="block text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                  Folder
                  <Select
                    className="mt-1"
                    aria-label="Template folder"
                    value={folderFilter}
                    onChange={(e) => setFolderFilter(e.target.value)}
                    disabled={folderSelectOptions.length === 0}
                  >
                    {folderSelectOptions.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </Select>
                </label>
                {templatesForTemplatesTab.length === 0 ? (
                  <p className="px-1 py-4 text-center text-[12px] text-ink-faint">No templates</p>
                ) : (
                  <ul className="space-y-1">
                    {templatesForTemplatesTab.map((t) => (
                      <li key={t.id}>
                        <button
                          type="button"
                          draggable
                          onDragStart={(e) => {
                            const payload = JSON.stringify({ templateId: t.id, name: t.name });
                            e.dataTransfer.setData(MIME_TEMPLATE, payload);
                            e.dataTransfer.setData('text/plain', payload);
                          }}
                          onClick={() => setInspectorTarget({ kind: 'template', templateId: t.id })}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-[13px]',
                            inspectorTarget?.kind === 'template' && inspectorTarget.templateId === t.id
                              ? 'border-primary bg-primary/10'
                              : 'border-border bg-surface hover:border-ink-faint',
                          )}
                        >
                          {live.includes(t.id) && <span className="h-2 w-2 shrink-0 rounded-full bg-live" aria-label="on air" />}
                          <span className="min-w-0 flex-1 truncate">{t.name}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {tab === 'data' && (
              <div className="space-y-2">
                <label className="block text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                  Folder
                  <Select
                    className="mt-1"
                    aria-label="Data folder"
                    value={dataFolderFilter}
                    onChange={(e) => {
                      setDataFolderFilter(e.target.value);
                      setDataTemplateFilter('all');
                    }}
                    disabled={folderSelectOptions.length === 0}
                  >
                    {folderSelectOptions.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </Select>
                </label>
                <label className="block text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                  Template
                  <Select
                    className="mt-1"
                    aria-label="Data template"
                    value={dataTemplateFilter}
                    onChange={(e) => setDataTemplateFilter(e.target.value)}
                  >
                    <option value="all">All</option>
                    {templatesForDataTab.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </Select>
                </label>
                {dataElementsForList.length === 0 ? (
                  <p className="px-1 py-4 text-center text-[12px] text-ink-faint">No data elements</p>
                ) : (
                  <ul className="space-y-1">
                    {dataElementsForList.map((de) => (
                      <li key={de.id}>
                        <button
                          type="button"
                          draggable
                          onDragStart={(e) => {
                            const payload = JSON.stringify({
                              dataElementId: de.id,
                              templateId: de.templateId,
                              name: de.name,
                              payload: de.payload,
                              vars: de.payload,
                            });
                            e.dataTransfer.setData(MIME_DATA_ELEMENT, payload);
                            e.dataTransfer.setData('text/plain', payload);
                          }}
                          onClick={() => setInspectorTarget({ kind: 'dataElement', dataElementId: de.id })}
                          className={cn(
                            'flex w-full flex-col rounded-md border px-2.5 py-1.5 text-left text-[13px]',
                            inspectorTarget?.kind === 'dataElement' && inspectorTarget.dataElementId === de.id
                              ? 'border-primary bg-primary/10'
                              : 'border-border bg-surface hover:border-ink-faint',
                          )}
                        >
                          <span className="truncate font-medium">{de.name}</span>
                          <span className="truncate text-[11px] text-ink-faint">
                            {templates.find((t) => t.id === de.templateId)?.name ?? de.templateId}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Center: rundown editor */}
        <div className="min-h-0 min-w-0 border-r border-border">
          <RundownTab
            channels={channels}
            templates={visibleTemplates}
            rundowns={channelRundowns}
            setRundowns={(next) => {
              const inChannel = (r: Rundown) => r.channel_id === channelId || r.channel_id == null;
              setRundowns((prev) => {
                const channelOnly = prev.filter(inChannel);
                const updated = typeof next === 'function' ? next(channelOnly) : next;
                const updatedIds = new Set(updated.map((r) => r.id));
                const others = prev.filter((r) => !inChannel(r) && !updatedIds.has(r.id));
                return [...updated, ...others];
              });
            }}
            dataLoaded={controlDataLoaded}
            onAir={onAir}
            setOnAir={setOnAir}
            fallbackChannelId={channelId || 'default'}
            send={send}
            onAirDetails={onAirDetails}
            onPreferredChannelChange={setRundownMonitorChannel}
            dataElements={dataElements}
            selectedRundownId={selectedRundownId}
            onSelectRundown={setSelectedRundownId}
            showRundownList={false}
          />
        </div>

        {/* Right: monitor + inspector */}
        <div className="flex min-h-0 flex-col overflow-hidden">
          <div className="shrink-0 space-y-3 border-b border-border p-3">
            {monitorChannelId && <ProgramMonitor channelId={monitorChannelId} />}
            <div>
              <h3 className="mb-2 text-[12px] font-semibold text-ink-muted">On air ({monitorRows.length})</h3>
              {monitorRows.length === 0 ? (
                <p className="text-[12px] text-ink-faint">Nothing on air.</p>
              ) : (
                <ul className="max-h-32 space-y-1 overflow-auto">
                  {monitorRows.map((item) => (
                    <li key={item.templateId} className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5">
                      <span
                        className="min-w-0 flex-1 truncate text-[13px]"
                        title={formatOnAirRow(item, displayOnAirName(item.templateId, templates, rundowns), displayOnAirOwner(item, templates, rundowns))}
                      >
                        {formatOnAirRow(item, displayOnAirName(item.templateId, templates, rundowns), displayOnAirOwner(item, templates, rundowns))}
                      </span>
                      <button type="button" onClick={() => clearFromChannel(monitorChannelId, item.templateId)} className="text-ink-faint hover:text-danger" aria-label="Clear">
                        <X className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <ControlItemInspector
              target={inspectorTarget}
              dataElements={dataElements}
              onDataElementsChange={setDataElements}
              onCancel={() => setInspectorTarget(null)}
            />
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
        type="button"
        onClick={async () => { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        className="grid h-8 w-8 place-items-center rounded-md border border-border text-ink-muted hover:text-ink"
        title="Copy Browser Source URL"
      >
        {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
}

function normalizeRundown(rundown: Rundown): Rundown {
  const slots = Array.isArray(rundown.slots) ? rundown.slots : [];
  return {
    ...rundown,
    slots: slots.map((slot, idx) => normalizeSlotTree(slot, idx)),
  };
}

function normalizeSlotTree(slot: Rundown['slots'][number], idx: number): Rundown['slots'][number] {
  const vars = slot.vars ?? slot.variables ?? {};
  const name = slot.name ?? slot.label ?? (slot.kind === 'primary' ? 'Primary' : `Slot ${idx + 1}`);
  const children = Array.isArray(slot.children)
    ? slot.children.map((child, childIdx) => normalizeSlotTree(child, childIdx))
    : undefined;
  return {
    ...slot,
    slotId: slot.slotId ?? slot.id ?? createId(),
    name,
    vars,
    kind: slot.kind === 'primary' ? 'primary' : (slot.kind ?? 'item'),
    ...(children ? { children } : {}),
  };
}

function displayOnAirOwner(item: import('@/core/api').OnAirDetailsItem, templates: TemplateSummary[], rundowns: Rundown[]): string {
  if (templates.some((template) => template.id === item.templateId)) return 'template';
  for (const rundown of rundowns) {
    const slot = findSlot(rundown.slots, item.templateId) ?? findSlot(rundown.slots, item.slotId ?? '');
    if (slot) return `slot ${slot.slotId}`;
  }
  return onAirOwnerLabel(item);
}

function displayOnAirName(id: string, templates: TemplateSummary[], rundowns: Rundown[]): string {
  const tpl = templates.find((t) => t.id === id);
  if (tpl) return tpl.name;
  for (const rundown of rundowns) {
    const slot = findSlot(rundown.slots, id);
    if (slot) return `${rundown.name} / ${slot.name}`;
  }
  return id;
}

function findSlot(slots: Rundown['slots'], id: string): Rundown['slots'][number] | null {
  if (!id) return null;
  for (const slot of slots) {
    if (slot.slotId === id) return slot;
    if (slot.children) {
      const nested = findSlot(slot.children, id);
      if (nested) return nested;
    }
  }
  return null;
}
