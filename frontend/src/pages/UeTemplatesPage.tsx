// frontend/src/pages/UeTemplatesPage.tsx
//
// Unreal Blueprint template catalog (ZeroDensity-style forms).
// Channel = UE engine/I/O; this page = reusable Blueprint TAKE definitions.

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Trash2, Loader2, Box, Save, Play, Square } from 'lucide-react';
import {
  api,
  ApiError,
  type Channel,
  type UeTemplateRecord,
  type UeTemplateSummary,
  type UeTemplateData,
} from '@/core/api';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/form';
import { toast } from '@/core/toast';
import { cn } from '@/lib/cn';

function emptyData(): UeTemplateData {
  return {
    schemaVersion: 1,
    description: '',
    rcObjectPath: '',
    takeIn: { functionName: 'TakeIn', parameters: {} },
    takeOut: { functionName: 'TakeOut', parameters: {} },
    actions: [],
    variables: [],
  };
}

export function UeTemplatesPage() {
  const [items, setItems] = useState<UeTemplateSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<UeTemplateRecord | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [playChannelId, setPlayChannelId] = useState('');
  const [saving, setSaving] = useState(false);
  const [playing, setPlaying] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, ch] = await Promise.all([api.ueTemplates.list(), api.channels.list()]);
      setItems(list);
      setChannels(ch.filter((c) => c.render_backend === 'unreal'));
      if (!selectedId && list.length) setSelectedId(list[0].id);
      if (!playChannelId) {
        const ue = ch.find((c) => c.render_backend === 'unreal');
        if (ue) setPlayChannelId(ue.id);
      }
    } catch (e) {
      toast.error(`Failed to load UE templates: ${(e as Error).message}`);
      setItems([]);
    }
  }, [selectedId, playChannelId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!selectedId) {
      setDraft(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const rec = await api.ueTemplates.get(selectedId);
        if (!cancelled) setDraft(rec);
      } catch (e) {
        if (!cancelled) toast.error(`Load failed: ${(e as Error).message}`);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedId]);

  async function create() {
    try {
      const created = await api.ueTemplates.create({
        name: `UE Template ${(items?.length ?? 0) + 1}`,
        data: emptyData(),
      });
      toast.success('UE template created');
      setSelectedId(created.id);
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      await api.ueTemplates.update(draft.id, { name: draft.name, data: draft.data });
      toast.success('Saved');
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string, name: string) {
    if (!window.confirm(`Delete UE template "${name}"?`)) return;
    try {
      await api.ueTemplates.remove(id);
      if (selectedId === id) setSelectedId(null);
      toast.success('Deleted');
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function play(mode: 'takeIn' | 'takeOut') {
    if (!draft || !playChannelId) {
      toast.error('Select an Unreal channel to play');
      return;
    }
    setPlaying(true);
    try {
      await api.ueTemplates.play(draft.id, { channelId: playChannelId, mode });
      toast.success(mode === 'takeIn' ? 'Take In sent' : 'Take Out sent');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setPlaying(false);
    }
  }

  function patchData<K extends keyof UeTemplateData>(key: K, value: UeTemplateData[K]) {
    setDraft((d) => (d ? { ...d, data: { ...d.data, [key]: value } } : d));
  }

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-[12px] font-semibold uppercase tracking-wide text-ink-muted">UE Templates</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => void create()}>
            <Plus className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {items === null ? (
            <Loader2 className="mx-auto mt-6 h-5 w-5 animate-spin text-ink-muted" />
          ) : items.length === 0 ? (
            <p className="p-3 text-[12px] text-ink-muted">
              No UE templates yet. Create one to map Blueprint TakeIn/TakeOut.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {items.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(t.id)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]',
                      selectedId === t.id ? 'bg-primary/15 text-ink' : 'text-ink-muted hover:bg-surface hover:text-ink',
                    )}
                  >
                    <Box className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{t.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="border-t border-border p-2 text-[11px] text-ink-muted">
          HTML templates stay under <Link className="text-primary hover:underline" to="/templates">Templates</Link>.
        </p>
      </aside>

      <div className="min-w-0 flex-1 overflow-auto p-5">
        {!draft ? (
          <p className="text-[13px] text-ink-muted">Select or create a UE template.</p>
        ) : (
          <div className="mx-auto max-w-xl space-y-4">
            <div>
              <h2 className="text-lg font-semibold">{draft.name}</h2>
              <p className="text-[12px] text-ink-muted">
                Describes which Blueprint to Take In / Out on an Unreal channel (like ZeroDensity form templates).
              </p>
            </div>

            <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
              <Field label="Name">
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </Field>
              <Field label="Blueprint / RC object path">
                <Input
                  value={draft.data.rcObjectPath}
                  placeholder="/Game/Maps/Studio.Studio:PersistentLevel.BP_LowerThird"
                  onChange={(e) => patchData('rcObjectPath', e.target.value)}
                />
              </Field>
              <Field label="Take In function">
                <Input
                  value={draft.data.takeIn?.functionName ?? 'TakeIn'}
                  onChange={(e) => patchData('takeIn', {
                    functionName: e.target.value,
                    parameters: draft.data.takeIn?.parameters ?? {},
                  })}
                />
              </Field>
              <Field label="Take Out function">
                <Input
                  value={draft.data.takeOut?.functionName ?? 'TakeOut'}
                  onChange={(e) => patchData('takeOut', {
                    functionName: e.target.value,
                    parameters: draft.data.takeOut?.parameters ?? {},
                  })}
                />
              </Field>
              <Field label="Description">
                <Input
                  value={draft.data.description ?? ''}
                  onChange={(e) => patchData('description', e.target.value)}
                />
              </Field>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={() => void save()} disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save
              </Button>
              <Button variant="ghost" onClick={() => void remove(draft.id, draft.name)}>
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            </div>

            <div className="space-y-2 rounded-lg border border-border bg-surface p-4">
              <h3 className="text-sm font-semibold">Test on channel</h3>
              <Field label="Unreal channel">
                <Select value={playChannelId} onChange={(e) => setPlayChannelId(e.target.value)}>
                  <option value="">Select…</option>
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </Select>
              </Field>
              {channels.length === 0 && (
                <p className="text-[12px] text-warning">
                  No channel with Render backend = Unreal. Create one in Settings first.
                </p>
              )}
              <div className="flex gap-2">
                <Button variant="primary" disabled={playing || !playChannelId} onClick={() => void play('takeIn')}>
                  <Play className="h-4 w-4" /> Take In
                </Button>
                <Button variant="neutral" disabled={playing || !playChannelId} onClick={() => void play('takeOut')}>
                  <Square className="h-4 w-4" /> Take Out
                </Button>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!playChannelId}
                onClick={() => {
                  void api.ueTemplates.play(draft.id, { channelId: playChannelId, mode: 'takeIn', dryRun: true })
                    .then((r) => toast.success(`Dry-run OK (${r.mode ?? 'takeIn'})`))
                    .catch((e) => toast.error((e as Error).message));
                }}
              >
                Dry-run Take In
              </Button>
            </div>

            <div className="rounded-lg border border-dashed border-border p-3 text-[12px] text-ink-muted">
              Extra actions: use <code className="text-ink">data.actions[]</code> via API for now; UI editor next.
              Add to rundown from Control when the channel is Unreal.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
