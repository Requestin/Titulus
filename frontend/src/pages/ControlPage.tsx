// frontend/src/pages/ControlPage.tsx
//
// Operator control panel — Rundowns only. Template TAKE/UPDATE/CLEAR lives under
// Templates → PLAY. On load restores on-air state from /api/onair (NFR-1).

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { X, Radio } from 'lucide-react';
import { api, type Channel, type TemplateSummary, type Rundown } from '@/core/api';
import { useControlWs } from '@/core/controlWs';
import { toast } from '@/core/toast';
import { Select } from '@/components/ui/form';
import { ProgramMonitor } from '@/control/ProgramMonitor';
import { RundownTab } from '@/control/RundownTab';
import {
  BrowserSourceUrl,
  WsBadge,
  displayOnAirName,
  normalizeRundown,
} from '@/control/controlShared';

export function ControlPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState<string>('');
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [rundowns, setRundowns] = useState<Rundown[]>([]);
  const [controlDataLoaded, setControlDataLoaded] = useState(false);
  const [onAir, setOnAir] = useState<Record<string, string[]>>({});
  const [rundownMonitorChannel, setRundownMonitorChannel] = useState<string>('');

  const status = useControlWs((s) => s.status);
  const connect = useControlWs((s) => s.connect);
  const send = useControlWs((s) => s.send);

  useEffect(() => { connect(); }, [connect]);

  useEffect(() => {
    (async () => {
      try {
        const [ch, tpl, rd, air] = await Promise.all([
          api.channels.list(), api.templates.list(), api.rundowns.list(), api.onair.get(),
        ]);
        setChannels(ch);
        setTemplates(tpl);
        setRundowns(rd.map(normalizeRundown));
        setOnAir(air);
        if (ch.length && !channelId) setChannelId(ch[0].id);
      } catch (e) {
        toast.error(`Failed to load control data: ${(e as Error).message}`);
      } finally {
        setControlDataLoaded(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const monitorChannelId = rundownMonitorChannel || channelId || 'default';
  const monitorLive = onAir[monitorChannelId] ?? [];
  const browserSourceUrl = monitorChannelId ? `${location.origin}/channel.html?channel=${monitorChannelId}` : '';

  function clearFromChannel(targetChannelId: string, templateId: string) {
    send({ type: 'clear', channelId: targetChannelId, templateId });
    setOnAir((prev) => ({
      ...prev,
      [targetChannelId]: (prev[targetChannelId] ?? []).filter((x) => x !== templateId),
    }));
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
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_380px]">
        <div className="min-w-0 border-r border-border">
          <div className="min-h-0 h-full overflow-auto">
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
              onPreferredChannelChange={setRundownMonitorChannel}
            />
          </div>
        </div>

        <div className="flex min-h-0 flex-col gap-4 overflow-auto p-4">
          {monitorChannelId && <ProgramMonitor channelId={monitorChannelId} />}
          <div>
            <h3 className="mb-2 text-[12px] font-semibold text-ink-muted">On air ({monitorLive.length})</h3>
            {monitorLive.length === 0 ? (
              <p className="text-[12px] text-ink-faint">Nothing on air.</p>
            ) : (
              <ul className="space-y-1">
                {monitorLive.map((tid) => (
                  <li key={tid} className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-[13px]">{displayOnAirName(tid, templates, rundowns) ?? tid}</span>
                    <button onClick={() => clearFromChannel(monitorChannelId, tid)} className="text-ink-faint hover:text-danger" aria-label="Clear"><X className="h-4 w-4" /></button>
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
