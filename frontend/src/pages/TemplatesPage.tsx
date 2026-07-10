// frontend/src/pages/TemplatesPage.tsx
//
// Templates hub: EDITOR (library + open editor) | PLAY (operator TAKE/UPDATE/CLEAR
// for templates — formerly Control → Templates tab).

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Trash2, Loader2, LayoutTemplate, Copy, Radio, X } from 'lucide-react';
import { createDefaultTemplate } from '@runtime';
import {
  api,
  type Channel,
  type TemplateSummary,
  type TemplateRecord,
} from '@/core/api';
import { createId } from '@/core/id';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/form';
import { toast } from '@/core/toast';
import { useControlWs } from '@/core/controlWs';
import { cn } from '@/lib/cn';
import { ProgramMonitor } from '@/control/ProgramMonitor';
import { TemplatesTab } from '@/control/TemplatesTab';
import { BrowserSourceUrl, WsBadge } from '@/control/controlShared';

type TemplatesMode = 'editor' | 'play';

export function TemplatesPage() {
  const [mode, setMode] = useState<TemplatesMode>('editor');

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 justify-center border-b border-border px-5 py-3">
        <ModeToggle mode={mode} onChange={setMode} />
      </div>
      <div className="min-h-0 flex-1">
        {mode === 'editor' ? <EditorLibrary /> : <PlayTemplates />}
      </div>
    </div>
  );
}

function ModeToggle({ mode, onChange }: { mode: TemplatesMode; onChange: (m: TemplatesMode) => void }) {
  return (
    <div
      role="tablist"
      aria-label="Templates mode"
      className="inline-flex rounded-md border border-border bg-surface p-0.5"
    >
      {([
        { id: 'editor', label: 'EDITOR' },
        { id: 'play', label: 'PLAY' },
      ] as const).map((item) => {
        const selected = mode === item.id;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(item.id)}
            className={cn(
              'min-w-[6.5rem] rounded-[5px] px-4 py-1.5 text-[12px] font-semibold tracking-wide transition-colors',
              selected
                ? 'bg-primary text-primary-ink shadow-sm'
                : 'text-ink-muted hover:text-ink',
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

function EditorLibrary() {
  const nav = useNavigate();
  const [items, setItems] = useState<TemplateSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api.templates.list());
    } catch (e) {
      toast.error(`Failed to load templates: ${(e as Error).message}`);
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setCreating(true);
    try {
      const rec = await api.templates.create('Untitled template', createDefaultTemplate());
      nav(`/editor/${rec.id}`);
    } catch (e) {
      toast.error(`Create failed: ${(e as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

  async function duplicate(id: string, name: string) {
    setDuplicatingId(id);
    try {
      const rec = await api.templates.get(id);
      const copyName = `${name}(copy)`;
      const data = structuredClone(rec.data);
      data.id = createId();
      data.name = copyName;
      const created = await api.templates.create(copyName, data);
      setItems((cur) => [...(cur ?? []), created]);
      toast.success(`Copied as "${copyName}"`);
    } catch (e) {
      toast.error(`Copy failed: ${(e as Error).message}`);
    } finally {
      setDuplicatingId(null);
    }
  }

  async function confirmRemove() {
    if (!pendingDelete) return;
    const { id } = pendingDelete;
    setPendingDelete(null);
    try {
      await api.templates.remove(id);
      setItems((cur) => (cur ?? []).filter((t) => t.id !== id));
      toast.success('Template deleted');
    } catch (e) {
      toast.error(`Delete failed: ${(e as Error).message}`);
    }
  }

  return (
    <div className="mx-auto max-w-5xl overflow-auto p-6">
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Templates</h2>
          <p className="text-[13px] text-ink-muted">
            Design title graphics. The editor preview is the on-air render.
          </p>
        </div>
        <Button variant="primary" onClick={create} disabled={creating}>
          {creating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
          New template
        </Button>
      </div>

      {items === null ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-[164px] animate-pulse rounded-lg border border-border bg-surface" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-surface/40 px-6 py-16 text-center">
          <LayoutTemplate className="h-8 w-8 text-ink-faint" aria-hidden />
          <div>
            <p className="text-sm font-medium">No templates yet</p>
            <p className="text-[13px] text-ink-muted">Create your first title graphic to start.</p>
          </div>
          <Button variant="primary" onClick={create} disabled={creating}>
            <Plus className="h-4 w-4" aria-hidden />
            New template
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {items.map((t) => (
            <div
              key={t.id}
              className="group flex flex-col overflow-hidden rounded-lg border border-border bg-surface transition-colors hover:border-ink-faint"
            >
              <button
                onClick={() => nav(`/editor/${t.id}`)}
                className="grid aspect-video place-items-center bg-surface-2 text-ink-faint"
                aria-label={`Open ${t.name}`}
              >
                <LayoutTemplate className="h-7 w-7" aria-hidden />
              </button>
              <div className="flex items-center justify-between gap-2 px-3 py-2.5">
                <button onClick={() => nav(`/editor/${t.id}`)} className="min-w-0 flex-1 text-left">
                  <div className="truncate text-sm font-medium">{t.name}</div>
                  <div className="truncate text-xs text-ink-faint">Updated {t.updated_at}</div>
                </button>
                <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={() => duplicate(t.id, t.name)}
                    disabled={duplicatingId === t.id}
                    aria-label={`Duplicate ${t.name}`}
                    title="Duplicate template"
                    className="grid h-7 w-7 place-items-center rounded text-ink-faint hover:bg-surface-2 hover:text-ink disabled:opacity-40"
                  >
                    {duplicatingId === t.id
                      ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      : <Copy className="h-4 w-4" aria-hidden />}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingDelete({ id: t.id, name: t.name })}
                    aria-label={`Delete ${t.name}`}
                    title="Delete template"
                    className="grid h-7 w-7 place-items-center rounded text-ink-faint hover:bg-surface-2 hover:text-danger"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {pendingDelete && (
        <div className="fixed inset-0 z-modal grid place-items-center bg-bg/70 px-4 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-template-title"
            className="w-full max-w-sm rounded-xl border border-border bg-surface p-5 shadow-2xl"
          >
            <p id="delete-template-title" className="text-sm text-ink">
              {`Delete "${pendingDelete.name}"? This cannot be undone.`}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="danger" onClick={() => { void confirmRemove(); }}>Delete</Button>
              <Button variant="neutral" onClick={() => setPendingDelete(null)}>Cancel</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PlayTemplates() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState<string>('');
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [onAir, setOnAir] = useState<Record<string, string[]>>({});
  const [loaded, setLoaded] = useState(false);

  const status = useControlWs((s) => s.status);
  const connect = useControlWs((s) => s.connect);
  const send = useControlWs((s) => s.send);

  useEffect(() => { connect(); }, [connect]);

  useEffect(() => {
    (async () => {
      try {
        const [ch, tpl, air] = await Promise.all([
          api.channels.list(), api.templates.list(), api.onair.get(),
        ]);
        setChannels(ch);
        setTemplates(tpl);
        setOnAir(air);
        if (ch.length) setChannelId((cur) => cur || ch[0].id);
      } catch (e) {
        toast.error(`Failed to load play data: ${(e as Error).message}`);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const live = onAir[channelId] ?? [];
  const monitorChannelId = channelId || 'default';
  const browserSourceUrl = channelId ? `${location.origin}/channel.html?channel=${channelId}` : '';

  function take(rec: TemplateRecord, values: Record<string, string | number>) {
    if (!channelId) { toast.error('Select a channel first'); return; }
    const ok = send({ type: 'take', channelId, templateId: rec.id, template: rec.data, variables: values });
    if (!ok) { toast.error('Control WebSocket not connected'); return; }
    setOnAir((prev) => ({ ...prev, [channelId]: Array.from(new Set([...(prev[channelId] ?? []), rec.id])) }));
  }
  function update(templateId: string, values: Record<string, string | number>) {
    if (!channelId) return;
    send({ type: 'update', channelId, templateId, variables: values });
  }
  function clear(templateId: string) {
    if (!channelId) return;
    send({ type: 'clear', channelId, templateId });
    setOnAir((prev) => ({ ...prev, [channelId]: (prev[channelId] ?? []).filter((x) => x !== templateId) }));
  }
  function clearAll() {
    if (!channelId) return;
    send({ type: 'clear', channelId });
    setOnAir((prev) => ({ ...prev, [channelId]: [] }));
  }

  if (loaded && channels.length === 0) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div className="space-y-2">
          <Radio className="mx-auto h-8 w-8 text-ink-faint" aria-hidden />
          <p className="text-sm font-medium">No channels yet</p>
          <p className="text-[13px] text-ink-muted">Create a channel to put graphics on air.</p>
          <Link to="/settings" className="inline-block text-primary hover:underline">Go to Settings</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
        <Select value={channelId} onChange={(e) => setChannelId(e.target.value)} className="w-48" disabled={!channels.length}>
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

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_380px]">
        <div className="min-w-0 border-r border-border">
          <TemplatesTab templates={templates} live={live} onTake={take} onUpdate={update} onClear={clear} />
        </div>
        <div className="flex min-h-0 flex-col gap-4 overflow-auto p-4">
          {monitorChannelId && <ProgramMonitor channelId={monitorChannelId} />}
          <div>
            <h3 className="mb-2 text-[12px] font-semibold text-ink-muted">On air ({live.length})</h3>
            {live.length === 0 ? (
              <p className="text-[12px] text-ink-faint">Nothing on air.</p>
            ) : (
              <ul className="space-y-1">
                {live.map((tid) => (
                  <li key={tid} className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-[13px]">
                      {templates.find((t) => t.id === tid)?.name ?? tid}
                    </span>
                    <button onClick={() => clear(tid)} className="text-ink-faint hover:text-danger" aria-label="Clear">
                      <X className="h-4 w-4" />
                    </button>
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
