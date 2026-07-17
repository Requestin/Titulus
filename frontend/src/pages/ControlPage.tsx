// frontend/src/pages/ControlPage.tsx
//
// Operator control panel — channel-scoped Rundowns + Templates/DataElements
// sidebar. Template TAKE/UPDATE/CLEAR for free templates lives under Templates → PLAY.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Radio } from 'lucide-react';
import { api, type Channel, type TemplateSummary, type Rundown, type OnAirSnapshot } from '@/core/api';
import { useControlWs } from '@/core/controlWs';
import { toast } from '@/core/toast';
import { Select } from '@/components/ui/form';
import { RundownTab } from '@/control/RundownTab';
import {
  BrowserSourceUrl,
  WsBadge,
  normalizeRundown,
} from '@/control/controlShared';

export function ControlPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState<string>('');
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [rundowns, setRundowns] = useState<Rundown[]>([]);
  const [controlDataLoaded, setControlDataLoaded] = useState(false);
  const [onAir, setOnAir] = useState<OnAirSnapshot>({});

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
        toast.error(`Failed to load control data: ${(e as Error).message}`);
      } finally {
        setControlDataLoaded(true);
      }
    })();
  }, []);

  // Poll on-air so End scene / waitingContinue from the renderer update Control UI.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const air = await api.onair.get();
        if (!cancelled) setOnAir(air);
      } catch {
        // ignore transient poll errors
      }
    };
    const id = window.setInterval(tick, 500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (!channelId) {
      setRundowns([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const rd = await api.rundowns.list({ channelId });
        if (!cancelled) setRundowns(rd.map(normalizeRundown));
      } catch (e) {
        if (!cancelled) toast.error(`Failed to load rundowns: ${(e as Error).message}`);
      }
    })();
    return () => { cancelled = true; };
  }, [channelId]);

  const browserSourceUrl = channelId ? `${location.origin}/channel.html?channel=${channelId}` : '';

  if (controlDataLoaded && channels.length === 0) {
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
        <Select
          value={channelId}
          onChange={(e) => setChannelId(e.target.value)}
          className="w-48"
          disabled={!channels.length}
        >
          {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <WsBadge status={status} />
        <div className="ml-auto flex items-center gap-2">
          <BrowserSourceUrl url={browserSourceUrl} />
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {channelId ? (
          <RundownTab
            channelId={channelId}
            templates={templates}
            rundowns={rundowns}
            setRundowns={setRundowns}
            dataLoaded={controlDataLoaded}
            onAir={onAir}
            setOnAir={setOnAir}
            send={send}
          />
        ) : (
          <div className="grid h-full place-items-center text-[13px] text-ink-muted">Select a channel…</div>
        )}
      </div>
    </div>
  );
}
