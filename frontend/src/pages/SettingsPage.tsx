// frontend/src/pages/SettingsPage.tsx
//
// Settings shell: Channels | License | User interface | Users and groups.
// Channel CRUD drives run-engines.sh consumer selection (REQ-11).

import { useCallback, useEffect, useState } from 'react';
import {
  Plus, Trash2, Loader2, Radio, Save, RefreshCw, ShieldCheck, ShieldOff, ClipboardList, Pencil,
} from 'lucide-react';
import {
  api,
  ApiError,
  ALL_PERMISSIONS,
  PERMISSION_LABELS,
  type AuthGroup,
  type AuthUser,
  type Channel,
  type KeyerMode,
  type OutputMode,
  type Permission,
  type RenderBackend,
  type LicenseState,
  type Entitlements,
  type AuditEvent,
} from '@/core/api';
import { Button } from '@/components/ui/Button';
import { Checkbox, Field, Input, Select } from '@/components/ui/form';
import { toast } from '@/core/toast';
import { cn } from '@/lib/cn';

const OUTPUT_MODES: { value: OutputMode; label: string }[] = [
  { value: 'browser', label: 'Browser (control panel preview)' },
  { value: 'obs_vmix', label: 'OBS / vMix (browser source URL)' },
  { value: 'decklink', label: 'DeckLink SDI Fill+Key' },
  { value: 'stream', label: 'Stream (SRT / RTMP)' },
];

const RENDER_BACKENDS: { value: RenderBackend; label: string }[] = [
  { value: 'html', label: 'HTML graphics (bg_engine)' },
  { value: 'unreal', label: 'Unreal engine channel (bg_vs_engine)' },
];

const KEYER_MODES: { value: KeyerMode; label: string }[] = [
  { value: 'external', label: 'External keyer' },
  { value: 'internal', label: 'Internal keyer' },
  { value: 'fill_only', label: 'Fill only' },
];

const DISPLAY_MODES = ['HD1080i50', 'HD1080p50', 'HD720p60', 'HD1080p25', 'HD1080i60'];

const SETTINGS_SECTIONS = [
  { id: 'channels', label: 'Channels' },
  { id: 'license', label: 'License' },
  { id: 'ui', label: 'User interface' },
  { id: 'users', label: 'Users and groups' },
] as const;

type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['id'];

const ADMINISTRATORS_GROUP = 'administrators';

type Draft = Omit<Channel, 'created_at'> & { isNew?: boolean };

function nextChannelName(channels: Channel[]): string {
  let max = 0;
  for (const c of channels) {
    const m = /^Channel(\d+)$/i.exec(c.name.trim());
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `Channel${max + 1}`;
}

function emptyDraft(name: string): Draft {
  return {
    id: '',
    name,
    output_mode: 'browser',
    device_index: -1,
    display_mode: 'HD1080i50',
    keyer_mode: 'external',
    stream_url: '',
    render_backend: 'html',
    unreal_endpoint: '',
    unreal_ndi_source: '',
    vs_input_device: -1,
    vs_bg_file: '',
    vs_cam_file: '',
    unreal_pad: [],
    isNew: true,
  };
}

function channelPayload(draft: Draft) {
  return {
    name: draft.name.trim(),
    output_mode: draft.output_mode,
    device_index: draft.device_index,
    display_mode: draft.display_mode,
    keyer_mode: draft.keyer_mode,
    stream_url: draft.stream_url,
    render_backend: draft.render_backend,
    unreal_endpoint: draft.unreal_endpoint,
    unreal_ndi_source: draft.unreal_ndi_source,
    vs_input_device: draft.vs_input_device,
    vs_bg_file: draft.vs_bg_file,
    vs_cam_file: draft.vs_cam_file,
    unreal_pad: draft.unreal_pad ?? [],
  };
}

function isAdministratorsGroup(g: AuthGroup): boolean {
  return g.name.toLowerCase() === ADMINISTRATORS_GROUP || !!g.isSystem;
}

export function SettingsPage() {
  const [section, setSection] = useState<SettingsSection>('channels');

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border">
        <div className="border-b border-border px-3 py-3">
          <h2 className="text-sm font-semibold">Settings</h2>
          <p className="text-[11px] text-ink-muted">Channels · license · access</p>
        </div>
        <nav className="min-h-0 flex-1 space-y-0.5 overflow-auto p-2">
          {SETTINGS_SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSection(s.id)}
              className={cn(
                'flex w-full items-center rounded-md px-2.5 py-2 text-left text-[13px] transition-colors',
                section === s.id
                  ? 'bg-primary/15 text-ink'
                  : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
              )}
            >
              {s.label}
            </button>
          ))}
        </nav>
      </aside>

      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        {section === 'channels' && <ChannelsSection />}
        {section === 'license' && <LicenseSection />}
        {section === 'ui' && (
          <div className="grid h-full place-items-center p-6 text-[13px] text-ink-faint">
            Coming soon.
          </div>
        )}
        {section === 'users' && <UsersAndGroupsSection />}
      </div>
    </div>
  );
}

/* ─── Channels ─────────────────────────────────────────────────────────── */

function ChannelsSection() {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await api.channels.list();
      setChannels(list);
      setSelectedId((cur) => {
        if (cur === '__new__') return cur;
        if (cur && list.some((c) => c.id === cur)) return cur;
        return list[0]?.id ?? null;
      });
    } catch (e) {
      toast.error(`Failed to load channels: ${(e as Error).message}`);
      setChannels([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!channels) return;
    if (selectedId === '__new__') {
      // Keep existing draft name when already drafting.
      setDraft((prev) => (prev?.isNew ? prev : emptyDraft(nextChannelName(channels))));
      return;
    }
    const ch = channels.find((c) => c.id === selectedId);
    setDraft(ch ? { ...ch } : null);
  }, [channels, selectedId]);

  function patch<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  function addChannel() {
    if (!channels) return;
    setDraft(emptyDraft(nextChannelName(channels)));
    setSelectedId('__new__');
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
    if (draft.render_backend === 'unreal' && draft.output_mode === 'decklink' && draft.device_index < 0) {
      toast.error('Unreal + DeckLink output requires device index >= 0');
      return;
    }
    setSaving(true);
    try {
      if (draft.isNew) {
        const created = await api.channels.create(channelPayload(draft));
        toast.success('Channel created');
        setSelectedId(created.id);
      } else {
        await api.channels.update(draft.id, channelPayload(draft));
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

  const atMax = (channels?.length ?? 0) >= 8;

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border">
        <div className="border-b border-border px-3 py-3">
          <h3 className="text-sm font-semibold">Channels</h3>
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
                    type="button"
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
              {selectedId === '__new__' && draft?.isNew && (
                <li>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md bg-primary/15 px-2.5 py-2 text-left text-[13px] text-ink"
                  >
                    <Radio className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{draft.name}</span>
                  </button>
                </li>
              )}
            </ul>
          )}
        </div>
        <div className="border-t border-border p-2">
          <Button
            variant="neutral"
            size="sm"
            className="w-full"
            disabled={atMax || selectedId === '__new__'}
            onClick={addChannel}
          >
            <Plus className="h-4 w-4" aria-hidden /> Add channel
          </Button>
        </div>
      </aside>

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
              <Field label="Render backend">
                <Select
                  value={draft.render_backend ?? 'html'}
                  onChange={(e) => patch('render_backend', e.target.value as RenderBackend)}
                >
                  {RENDER_BACKENDS.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Output">
                <Select value={draft.output_mode} onChange={(e) => patch('output_mode', e.target.value as OutputMode)}>
                  {OUTPUT_MODES.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </Select>
              </Field>

              {(draft.render_backend ?? 'html') === 'unreal' && (
                <div className="space-y-3 rounded-md border border-border/80 bg-bg/40 p-3">
                  <p className="text-[12px] text-ink-muted">
                    ZeroDensity-style: this channel is the <strong className="font-medium text-ink">UE engine / I/O</strong>.
                    Blueprint playout lives in <code className="text-ink">UE Templates</code>, then rundown.
                    Engine: <code className="text-ink">bg_vs_engine</code>.
                  </p>
                  <Field label="Unreal Remote Control URL">
                    <Input
                      value={draft.unreal_endpoint}
                      placeholder="http://127.0.0.1:30010"
                      onChange={(e) => patch('unreal_endpoint', e.target.value)}
                    />
                  </Field>
                  <p className="text-[11px] text-ink-muted">
                    Needed for TAKE of UE Templates. Optional for first video smoke (NDI/stub → keyer → BMD).
                  </p>
                  <Field label="NDI source (Unreal output)">
                    <Input
                      value={draft.unreal_ndi_source}
                      placeholder="UE5-Studio"
                      onChange={(e) => patch('unreal_ndi_source', e.target.value)}
                    />
                  </Field>
                  <Field label="Camera DeckLink input #">
                    <Input
                      type="number"
                      min={-1}
                      value={draft.vs_input_device}
                      onChange={(e) => patch('vs_input_device', parseInt(e.target.value, 10))}
                    />
                  </Field>
                  <p className="text-[11px] text-ink-muted">
                    −1 = synthetic green-screen stub (no camera card). Output device is below under DeckLink.
                  </p>
                  <details className="rounded border border-border/60 p-2 text-[12px]">
                    <summary className="cursor-pointer text-ink-muted">Advanced stubs (no NDI / no camera HW)</summary>
                    <div className="mt-2 space-y-2">
                      <Field label="BG file (raw BGRA)">
                        <Input
                          value={draft.vs_bg_file}
                          placeholder="/tmp/vs-bg.bgra"
                          onChange={(e) => patch('vs_bg_file', e.target.value)}
                        />
                      </Field>
                      <Field label="Camera file (raw BGRA)">
                        <Input
                          value={draft.vs_cam_file}
                          placeholder="/tmp/vs-cam.bgra"
                          onChange={(e) => patch('vs_cam_file', e.target.value)}
                        />
                      </Field>
                    </div>
                  </details>
                </div>
              )}

              {(draft.output_mode === 'browser' || draft.output_mode === 'obs_vmix') && (
                <p className="text-[12px] text-ink-muted">
                  Browser/OBS modes render via CEF; use the Browser Source URL on the Control panel
                  or point OBS at <code>/channel.html?channel={draft.id || '&lt;id&gt;'}</code>.
                </p>
              )}

              {draft.output_mode === 'decklink' && (
                <>
                  <Field label="Device # (output)">
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
                  <Field label="Keyer (hardware Fill+Key)">
                    <Select value={draft.keyer_mode} onChange={(e) => patch('keyer_mode', e.target.value as KeyerMode)}>
                      {KEYER_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                    </Select>
                  </Field>
                  <p className="text-[12px] text-warning">
                    DeckLink requires hardware + genlock for production validation (deferred on this dev host).
                    Hardware Fill+Key is not chroma key — VS chroma lives in bg_vs_engine.
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
              <Button variant="primary" onClick={() => void save()} disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
                {draft.isNew ? 'Create' : 'Save'}
              </Button>
              {!draft.isNew && (
                <Button variant="ghost" onClick={() => void remove(draft.id, draft.name)}>
                  <Trash2 className="h-4 w-4" aria-hidden /> Delete
                </Button>
              )}
              {draft.isNew && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setSelectedId(channels?.[0]?.id ?? null);
                    setDraft(null);
                  }}
                >
                  Cancel
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── License ──────────────────────────────────────────────────────────── */

function LicenseSection() {
  const [license, setLicense] = useState<LicenseState | null>(null);
  const [entitlements, setEntitlements] = useState<Entitlements | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [licenseKey, setLicenseKey] = useState('');
  const [holder, setHolder] = useState('');
  const [licenseBusy, setLicenseBusy] = useState(false);
  const [eventsBusy, setEventsBusy] = useState(false);

  const loadLicense = useCallback(async () => {
    try {
      setLicense(await api.license.get());
    } catch (e) {
      toast.error(`Failed to load license: ${(e as Error).message}`);
      setLicense(null);
    }
  }, []);

  const loadEntitlements = useCallback(async () => {
    try {
      setEntitlements(await api.billing.entitlements());
    } catch (e) {
      toast.error(`Failed to load entitlements: ${(e as Error).message}`);
      setEntitlements(null);
    }
  }, []);

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

  useEffect(() => {
    void loadLicense();
    void loadEntitlements();
    void loadEvents();
  }, [loadLicense, loadEntitlements, loadEvents]);

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

  return (
    <div className="mx-auto max-w-lg space-y-6 p-6">
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
  );
}

/* ─── Users and groups ─────────────────────────────────────────────────── */

type GroupDraft = {
  id?: string;
  name: string;
  permissions: Permission[];
  isSystem?: boolean;
};

type UserDraft = {
  id?: string;
  username: string;
  password: string;
  groupId: string;
  isActive: boolean;
};

function UsersAndGroupsSection() {
  const [groups, setGroups] = useState<AuthGroup[] | null>(null);
  const [users, setUsers] = useState<AuthUser[] | null>(null);
  const [groupDraft, setGroupDraft] = useState<GroupDraft | null>(null);
  const [userDraft, setUserDraft] = useState<UserDraft | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [g, u] = await Promise.all([api.auth.listGroups(), api.auth.listUsers()]);
      setGroups(g);
      setUsers(u);
    } catch (e) {
      toast.error(`Failed to load users/groups: ${(e as Error).message}`);
      setGroups([]);
      setUsers([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function saveGroup() {
    if (!groupDraft) return;
    const name = groupDraft.name.trim();
    if (!name) {
      toast.error('Group name is required');
      return;
    }
    setBusy(true);
    try {
      if (groupDraft.id) {
        const locked = isAdministratorsGroup({
          id: groupDraft.id,
          name: groupDraft.name,
          isSystem: groupDraft.isSystem,
          permissions: groupDraft.permissions,
        });
        const permissions = locked
          ? [...new Set([...groupDraft.permissions, 'settings' as Permission])]
          : groupDraft.permissions;
        await api.auth.updateGroup(groupDraft.id, {
          name: locked ? undefined : name,
          permissions,
        });
        toast.success('Group saved');
      } else {
        await api.auth.createGroup({ name, permissions: groupDraft.permissions });
        toast.success('Group created');
      }
      setGroupDraft(null);
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteGroup(g: AuthGroup) {
    if (isAdministratorsGroup(g)) {
      toast.error('Cannot delete the administrators group');
      return;
    }
    if (!window.confirm(`Delete group "${g.name}"?`)) return;
    setBusy(true);
    try {
      await api.auth.deleteGroup(g.id);
      toast.success('Group deleted');
      if (groupDraft?.id === g.id) setGroupDraft(null);
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveUser() {
    if (!userDraft) return;
    const username = userDraft.username.trim();
    if (!username) {
      toast.error('Username is required');
      return;
    }
    if (!userDraft.id && !userDraft.password) {
      toast.error('Password is required');
      return;
    }
    if (!userDraft.groupId) {
      toast.error('Group is required');
      return;
    }
    setBusy(true);
    try {
      if (userDraft.id) {
        await api.auth.updateUser(userDraft.id, {
          username,
          groupId: userDraft.groupId,
          isActive: userDraft.isActive,
          ...(userDraft.password ? { password: userDraft.password } : {}),
        });
        toast.success('User saved');
      } else {
        await api.auth.createUser({
          username,
          password: userDraft.password,
          groupId: userDraft.groupId,
          isActive: userDraft.isActive,
        });
        toast.success('User created');
      }
      setUserDraft(null);
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const defaultGroupId = groups?.find((g) => g.name.toLowerCase() === 'operators')?.id
    ?? groups?.[0]?.id
    ?? '';

  return (
    <div className="space-y-8 p-6">
      {/* Groups */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">Groups</h3>
            <p className="text-[12px] text-ink-muted">Permissions control which pages a member can open.</p>
          </div>
          <Button
            variant="neutral"
            size="sm"
            disabled={!!groupDraft}
            onClick={() => setGroupDraft({ name: '', permissions: ['control'] })}
          >
            <Plus className="h-4 w-4" aria-hidden /> Add group
          </Button>
        </div>

        {groupDraft && (
          <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
            <Field label="Name">
              <Input
                value={groupDraft.name}
                disabled={!!groupDraft.id && (groupDraft.isSystem || groupDraft.name.toLowerCase() === ADMINISTRATORS_GROUP)}
                onChange={(e) => setGroupDraft({ ...groupDraft, name: e.target.value })}
              />
            </Field>
            <div className="grid gap-2 sm:grid-cols-2">
              {ALL_PERMISSIONS.map((perm) => {
                const isAdmins = !!groupDraft.id && (
                  groupDraft.isSystem || groupDraft.name.toLowerCase() === ADMINISTRATORS_GROUP
                );
                const settingsLocked = isAdmins && perm === 'settings';
                return (
                  <Checkbox
                    key={perm}
                    label={PERMISSION_LABELS[perm]}
                    checked={settingsLocked || groupDraft.permissions.includes(perm)}
                    disabled={settingsLocked}
                    onChange={(v) => {
                      if (settingsLocked) return;
                      setGroupDraft({
                        ...groupDraft,
                        permissions: v
                          ? [...new Set([...groupDraft.permissions, perm])]
                          : groupDraft.permissions.filter((p) => p !== perm),
                      });
                    }}
                  />
                );
              })}
            </div>
            <div className="flex gap-2">
              <Button variant="primary" size="sm" disabled={busy} onClick={() => void saveGroup()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
                {groupDraft.id ? 'Save' : 'Create'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setGroupDraft(null)}>Cancel</Button>
            </div>
          </div>
        )}

        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-border bg-surface-2 text-[11px] uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Permissions</th>
                <th className="px-3 py-2 font-medium w-28" />
              </tr>
            </thead>
            <tbody>
              {groups === null ? (
                <tr><td colSpan={3} className="px-3 py-4 text-ink-faint">Loading…</td></tr>
              ) : groups.length === 0 ? (
                <tr><td colSpan={3} className="px-3 py-4 text-ink-faint">No groups.</td></tr>
              ) : (
                groups.map((g) => {
                  const locked = isAdministratorsGroup(g);
                  const perms = locked
                    ? [...new Set([...(g.permissions ?? []), 'settings' as Permission])]
                    : (g.permissions ?? []);
                  return (
                    <tr key={g.id} className="border-b border-border last:border-0">
                      <td className="px-3 py-2 font-medium text-ink">{g.name}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-x-3 gap-y-1">
                          {ALL_PERMISSIONS.map((perm) => (
                            <Checkbox
                              key={perm}
                              label={PERMISSION_LABELS[perm]}
                              checked={perms.includes(perm)}
                              disabled
                              onChange={() => {}}
                            />
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setGroupDraft({
                              id: g.id,
                              name: g.name,
                              permissions: [...perms],
                              isSystem: locked || g.isSystem,
                            })}
                          >
                            <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
                          </Button>
                          {!locked && (
                            <Button variant="ghost" size="sm" onClick={() => void deleteGroup(g)}>
                              <Trash2 className="h-3.5 w-3.5" aria-hidden />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Users */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">Users</h3>
            <p className="text-[12px] text-ink-muted">Each user belongs to one group.</p>
          </div>
          <Button
            variant="neutral"
            size="sm"
            disabled={!!userDraft || !defaultGroupId}
            onClick={() => setUserDraft({
              username: '',
              password: '',
              groupId: defaultGroupId,
              isActive: true,
            })}
          >
            <Plus className="h-4 w-4" aria-hidden /> Add user
          </Button>
        </div>

        {userDraft && (
          <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
            <Field label="Username">
              <Input
                value={userDraft.username}
                onChange={(e) => setUserDraft({ ...userDraft, username: e.target.value })}
                autoComplete="off"
              />
            </Field>
            <Field label="Group">
              <Select
                value={userDraft.groupId}
                onChange={(e) => setUserDraft({ ...userDraft, groupId: e.target.value })}
              >
                {(groups ?? []).map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </Select>
            </Field>
            <Field label={userDraft.id ? 'Password (optional)' : 'Password'}>
              <Input
                type="password"
                value={userDraft.password}
                placeholder={userDraft.id ? 'Leave blank to keep' : ''}
                onChange={(e) => setUserDraft({ ...userDraft, password: e.target.value })}
                autoComplete="new-password"
              />
            </Field>
            {userDraft.id && (
              <Checkbox
                label="Active"
                checked={userDraft.isActive}
                onChange={(v) => setUserDraft({ ...userDraft, isActive: v })}
              />
            )}
            <div className="flex gap-2">
              <Button variant="primary" size="sm" disabled={busy} onClick={() => void saveUser()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
                {userDraft.id ? 'Save' : 'Create'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setUserDraft(null)}>Cancel</Button>
            </div>
          </div>
        )}

        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-border bg-surface-2 text-[11px] uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Username</th>
                <th className="px-3 py-2 font-medium">Group</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium w-24" />
              </tr>
            </thead>
            <tbody>
              {users === null ? (
                <tr><td colSpan={4} className="px-3 py-4 text-ink-faint">Loading…</td></tr>
              ) : users.length === 0 ? (
                <tr><td colSpan={4} className="px-3 py-4 text-ink-faint">No users.</td></tr>
              ) : (
                users.map((u) => (
                  <tr key={u.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 font-medium text-ink">{u.username}</td>
                    <td className="px-3 py-2 text-ink-muted">{u.groupName || '—'}</td>
                    <td className="px-3 py-2 text-ink-muted">{u.isActive ? 'active' : 'inactive'}</td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setUserDraft({
                            id: u.id,
                            username: u.username,
                            password: '',
                            groupId: u.groupId || defaultGroupId,
                            isActive: u.isActive,
                          })}
                        >
                          <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
