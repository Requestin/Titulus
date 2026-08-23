// frontend/src/pages/SettingsPage.tsx
//
// Channel + output mode settings (DEVELOPMENT_PROMPT §8.5, REQ-11).
// CRUD for up to 8 channels with output_mode, DeckLink device/format/keyer,
// and stream URL. Used by run-engines.sh to pick consumer per channel.

import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Loader2, Radio, Save, RefreshCw, ShieldCheck, ShieldOff, ClipboardList } from 'lucide-react';
import {
  api,
  ApiError,
  type Channel,
  type KeyerMode,
  type OutputMode,
  type LicenseState,
  type Entitlements,
  type AuditEvent,
} from '@/core/api';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/form';
import { toast } from '@/core/toast';
import { cn } from '@/lib/cn';

const OUTPUT_MODES: { value: OutputMode; label: string }[] = [
  { value: 'browser', label: 'Browser (control panel preview)' },
  { value: 'obs_vmix', label: 'OBS / vMix (browser source URL)' },
  { value: 'decklink', label: 'DeckLink SDI Fill+Key' },
  { value: 'stream', label: 'Stream (SRT / RTMP)' },
];

const KEYER_MODES: { value: KeyerMode; label: string }[] = [
  { value: 'external', label: 'External keyer' },
  { value: 'internal', label: 'Internal keyer' },
  { value: 'fill_only', label: 'Fill only' },
];

const DISPLAY_MODES = ['HD1080i50', 'HD1080p50', 'HD720p60', 'HD1080p25', 'HD1080i60'];

type Draft = Omit<Channel, 'created_at'> & { isNew?: boolean };

function emptyDraft(): Draft {
  return {
    id: '',
    name: 'Channel 1',
    output_mode: 'browser',
    device_index: -1,
    display_mode: 'HD1080i50',
    keyer_mode: 'external',
    stream_url: '',
    isNew: true,
  };
}

export function SettingsPage() {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [license, setLicense] = useState<LicenseState | null>(null);
  const [entitlements, setEntitlements] = useState<Entitlements | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [licenseKey, setLicenseKey] = useState('');
  const [holder, setHolder] = useState('');
  const [licenseBusy, setLicenseBusy] = useState(false);
  const [eventsBusy, setEventsBusy] = useState(false);
  const [layerIdPlayout, setLayerIdPlayout] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await api.channels.list();
      setChannels(list);
      if (list.length && !selectedId) setSelectedId(list[0].id);
    } catch (e) {
      toast.error(`Failed to load channels: ${(e as Error).message}`);
      setChannels([]);
    }
  }, [selectedId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void api.settings.get().then((all) => setLayerIdPlayout(all.layerIdPlayout === 'on')).catch(() => undefined);
  }, []);

  const loadLicense = useCallback(async () => {
    try {
      setLicense(await api.license.get());
    } catch (e) {
      toast.error(`Failed to load license: ${(e as Error).message}`);
      setLicense(null);
    }
  }, []);

  useEffect(() => { void loadLicense(); }, [loadLicense]);

  const loadEntitlements = useCallback(async () => {
    try {
      setEntitlements(await api.billing.entitlements());
    } catch (e) {
      toast.error(`Failed to load entitlements: ${(e as Error).message}`);
      setEntitlements(null);
    }
  }, []);

  useEffect(() => { void loadEntitlements(); }, [loadEntitlements]);

  const loadEvents = useCallback(async () => {
    setEventsBusy(true);
    try {
      setEvents(await api.audit.events({ limit: 20 }));
    } catch (e) {
      toast.error(`Failed to load audit events: ${(e as Error).message}`);
      setEvents([]);
    } finally {
      setEventsBusy(false);
    }
  }, []);

  useEffect(() => { void loadEvents(); }, [loadEvents]);

  useEffect(() => {
    if (!channels) return;
    if (selectedId === '__new__') {
      setDraft(emptyDraft());
      return;
    }
    const ch = channels.find((c) => c.id === selectedId);
    setDraft(ch ? { ...ch } : null);
  }, [channels, selectedId]);

  function patch<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  async function save() {
    if (!draft) return;
    if (!draft.name.trim()) {
      toast.error('Channel name is required');
      return;
    }
    if (draft.output_mode === 'decklink' && draft.device_index < 0) {
      toast.error('DeckLink output requires device index >= 0');
      return;
    }
    if (draft.output_mode === 'stream' && !draft.stream_url.trim()) {
      toast.error('Stream output requires a stream URL');
      return;
    }
    setSaving(true);
    try {
      if (draft.isNew) {
        const created = await api.channels.create({
          name: draft.name.trim(),
          output_mode: draft.output_mode,
          device_index: draft.device_index,
          display_mode: draft.display_mode,
          keyer_mode: draft.keyer_mode,
          stream_url: draft.stream_url,
        });
        toast.success('Channel created');
        setSelectedId(created.id);
      } else {
        await api.channels.update(draft.id, {
          name: draft.name.trim(),
          output_mode: draft.output_mode,
          device_index: draft.device_index,
          display_mode: draft.display_mode,
          keyer_mode: draft.keyer_mode,
          stream_url: draft.stream_url,
        });
        toast.success('Channel saved');
      }
      await load();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string, name: string) {
    if (!window.confirm(`Delete channel "${name}"?`)) return;
    try {
      await api.channels.remove(id);
      toast.success('Channel deleted');
      setSelectedId(null);
      await load();
    } catch (e) {
      toast.error(`Delete failed: ${(e as Error).message}`);
    }
  }

  async function activateLicense() {
    if (!licenseKey.trim()) {
      toast.error('License key is required');
      return;
    }
    setLicenseBusy(true);
    try {
      const state = await api.license.activate({
        licenseKey: licenseKey.trim(),
        holder: holder.trim() || undefined,
      });
      setLicense(state);
      await Promise.all([loadEntitlements(), loadEvents()]);
      setLicenseKey('');
      toast.success('License activated');
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      toast.error(msg);
    } finally {
      setLicenseBusy(false);
    }
  }

  async function deactivateLicense() {
    if (!window.confirm('Deactivate current license?')) return;
    setLicenseBusy(true);
    try {
      const state = await api.license.deactivate();
      setLicense(state);
      await Promise.all([loadEntitlements(), loadEvents()]);
      toast.success('License deactivated');
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      toast.error(msg);
    } finally {
      setLicenseBusy(false);
    }
  }

  const atMax = (channels?.length ?? 0) >= 8;

  return (
    <div className="flex h-full min-h-0">
      {/* Channel list */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-border">
        <div className="border-b border-border px-3 py-3">
          <h2 className="text-sm font-semibold">Channels</h2>
          <p className="text-[11px] text-ink-muted">Max 8 · output per channel</p>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {channels === null ? (
            <div className="space-y-1">{Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-9 animate-pulse rounded-md bg-surface" />
            ))}</div>
          ) : (
            <ul className="space-y-0.5">
              {channels.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => setSelectedId(c.id)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors',
                      selectedId === c.id ? 'bg-primary/15 text-ink' : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
                    )}
                  >
                    <Radio className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="border-t border-border p-2">
          <Button
            variant="neutral"
            size="sm"
            className="w-full"
            disabled={atMax}
            onClick={() => setSelectedId('__new__')}
          >
            <Plus className="h-4 w-4" aria-hidden /> Add channel
          </Button>
        </div>
      </aside>

      {/* Editor */}
      <div className="min-w-0 flex-1 overflow-auto p-6">
        {!draft ? (
          <div className="grid h-full place-items-center text-center text-[13px] text-ink-faint">
            {channels?.length === 0
              ? 'No channels yet. Add one to configure output.'
              : 'Select a channel to edit.'}
          </div>
        ) : (
          <div className="mx-auto max-w-lg space-y-6">
            <div>
              <h3 className="text-lg font-semibold">{draft.isNew ? 'New channel' : draft.name}</h3>
              <p className="text-[13px] text-ink-muted">
                Output mode drives how <code className="text-ink">run-engines.sh</code> launches{' '}
                <code className="text-ink">bg_engine</code> for this channel.
              </p>
            </div>

            <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
              <Field label="Name">
                <Input value={draft.name} onChange={(e) => patch('name', e.target.value)} />
              </Field>
              <Field label="Output">
                <Select value={draft.output_mode} onChange={(e) => patch('output_mode', e.target.value as OutputMode)}>
                  {OUTPUT_MODES.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </Select>
              </Field>

              {(draft.output_mode === 'browser' || draft.output_mode === 'obs_vmix') && (
                <p className="text-[12px] text-ink-muted">
                  Browser/OBS modes render via CEF; use the Browser Source URL on the Control panel
                  or point OBS at <code>/channel.html?channel={draft.id || '&lt;id&gt;'}</code>.
                </p>
              )}

              {draft.output_mode === 'decklink' && (
                <>
                  <Field label="Device #">
                    <Input
                      type="number"
                      min={0}
                      value={draft.device_index}
                      onChange={(e) => patch('device_index', parseInt(e.target.value, 10) || 0)}
                    />
                  </Field>
                  <Field label="Format">
                    <Select value={draft.display_mode} onChange={(e) => patch('display_mode', e.target.value)}>
                      {DISPLAY_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                    </Select>
                  </Field>
                  <Field label="Keyer">
                    <Select value={draft.keyer_mode} onChange={(e) => patch('keyer_mode', e.target.value as KeyerMode)}>
                      {KEYER_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                    </Select>
                  </Field>
                  <p className="text-[12px] text-warning">
                    DeckLink requires hardware + genlock for production validation (deferred on this dev host).
                  </p>
                </>
              )}

              {draft.output_mode === 'stream' && (
                <Field label="Stream URL">
                  <Input
                    value={draft.stream_url}
                    placeholder="srt://host:port or rtmp://..."
                    onChange={(e) => patch('stream_url', e.target.value)}
                  />
                </Field>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button variant="primary" onClick={save} disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
                {draft.isNew ? 'Create' : 'Save'}
              </Button>
              {!draft.isNew && (
                <Button variant="ghost" onClick={() => remove(draft.id, draft.name)}>
                  <Trash2 className="h-4 w-4" aria-hidden /> Delete
                </Button>
              )}
            </div>

            <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>
                  <span className="font-semibold">LayerID playout</span>
                  <span className="block text-[12px] text-ink-muted">Off by default. When on, the same LayerID replaces the occupant.</span>
                </span>
                <input
                  type="checkbox"
                  checked={layerIdPlayout}
                  onChange={async (e) => {
                    const on = e.target.checked;
                    setLayerIdPlayout(on);
                    try {
                      await api.settings.put({ layerIdPlayout: on ? 'on' : 'off' });
                    } catch (error) {
                      setLayerIdPlayout(!on);
                      toast.error(error instanceof Error ? error.message : 'Failed to save LayerID setting');
                    }
                  }}
                />
              </label>
            </div>
            <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h4 className="flex items-center gap-2 text-sm font-semibold">
                    {license?.status === 'active' ? (
                      <ShieldCheck className="h-4 w-4 text-success" aria-hidden />
                    ) : (
                      <ShieldOff className="h-4 w-4 text-warning" aria-hidden />
                    )}
                    License
                  </h4>
                  <p className="text-[12px] text-ink-muted">
                    Phase 6 foundation: local activation state for SaaS/on-prem licensing.
                  </p>
                </div>
                <Button
                  variant="neutral"
                  size="sm"
                  onClick={() => void Promise.all([loadLicense(), loadEntitlements(), loadEvents()])}
                  disabled={licenseBusy}
                >
                  <RefreshCw className={cn('h-4 w-4', licenseBusy && 'animate-spin')} aria-hidden />
                  Refresh
                </Button>
              </div>

              <div className="grid gap-2 text-[12px] text-ink-muted">
                <div>Status: <span className="font-medium text-ink">{license?.status ?? 'unknown'}</span></div>
                <div>Plan: <span className="font-medium text-ink">{license?.plan ?? 'none'}</span></div>
                <div>Holder: <span className="font-medium text-ink">{license?.holder || '—'}</span></div>
                <div>Key: <span className="font-medium text-ink">{license?.hasKey ? license?.keyMasked : 'not set'}</span></div>
                <div>Expires: <span className="font-medium text-ink">{license?.expiresAt ?? '—'}</span></div>
                {license?.lastError ? (
                  <div className="text-warning">Last error: {license.lastError}</div>
                ) : null}
              </div>

              <div className="rounded-md border border-border bg-surface-2 p-3 text-[12px] text-ink-muted">
                <div className="mb-1 font-medium text-ink">Entitlements</div>
                <div>Plan resolved: <span className="text-ink">{entitlements?.plan ?? 'none'}</span></div>
                <div>Max channels: <span className="text-ink">{entitlements?.limits.maxChannels ?? 0}</span></div>
                <div>DeckLink enabled: <span className="text-ink">{entitlements?.limits.decklink ? 'yes' : 'no'}</span></div>
                <div>Stream enabled: <span className="text-ink">{entitlements?.limits.stream ? 'yes' : 'no'}</span></div>
                <div>Users: <span className="text-ink">{entitlements?.limits.users ?? 1}</span></div>
              </div>

              <Field label="License key">
                <Input
                  value={licenseKey}
                  placeholder="TIT-XXXX-XXXX-XXXX-XXXX"
                  onChange={(e) => setLicenseKey(e.target.value.toUpperCase())}
                />
              </Field>

              <Field label="Holder (optional)">
                <Input
                  value={holder}
                  placeholder="Company / owner"
                  onChange={(e) => setHolder(e.target.value)}
                />
              </Field>

              <div className="flex items-center gap-2">
                <Button variant="primary" onClick={() => void activateLicense()} disabled={licenseBusy}>
                  {licenseBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                  Activate
                </Button>
                <Button variant="ghost" onClick={() => void deactivateLicense()} disabled={licenseBusy || !license?.hasKey}>
                  Deactivate
                </Button>
              </div>
            </div>

            <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
              <div className="flex items-center justify-between gap-2">
                <h4 className="flex items-center gap-2 text-sm font-semibold">
                  <ClipboardList className="h-4 w-4 text-info" aria-hidden />
                  Audit events
                </h4>
                <Button variant="neutral" size="sm" onClick={() => void loadEvents()} disabled={eventsBusy}>
                  {eventsBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                  Refresh
                </Button>
              </div>
              {events.length === 0 ? (
                <p className="text-[12px] text-ink-faint">No events yet.</p>
              ) : (
                <ul className="space-y-1">
                  {events.slice(0, 12).map((ev) => (
                    <li key={ev.id} className="rounded-md border border-border bg-surface-2 px-2.5 py-2 text-[12px]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium text-ink">{ev.eventType}</span>
                        <span className="tnum text-ink-faint">{ev.status}</span>
                      </div>
                      <div className="mt-0.5 truncate text-ink-muted">
                        {ev.method} {ev.path} · {ev.username || 'system'} · {ev.createdAt}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
