// frontend/src/control/UePlayoutPanel.tsx
//
// Operator playout for UE templates on an Unreal channel (+ add to rundown).

import { useCallback, useEffect, useState } from 'react';
import { Box, Loader2, Play, Plus, Square } from 'lucide-react';
import {
  api,
  ApiError,
  type Channel,
  type Rundown,
  type RundownSlot,
  type UeTemplateSummary,
} from '@/core/api';
import { createId } from '@/core/id';
import { Button } from '@/components/ui/Button';
import { toast } from '@/core/toast';

interface Props {
  channel: Channel;
  activeRundown: Rundown | null;
  onRundownUpdated: (rd: Rundown) => void;
}

export function UePlayoutPanel({ channel, activeRundown, onRundownUpdated }: Props) {
  const [items, setItems] = useState<UeTemplateSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await api.ueTemplates.list());
    } catch (e) {
      toast.error(`UE templates: ${(e as Error).message}`);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function play(id: string, mode: 'takeIn' | 'takeOut') {
    setBusyId(id);
    try {
      await api.ueTemplates.play(id, { channelId: channel.id, mode });
      toast.success(mode === 'takeIn' ? 'UE Take In' : 'UE Take Out');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function addToRundown(t: UeTemplateSummary) {
    if (!activeRundown) {
      toast.error('Select/create a rundown first');
      return;
    }
    const slot: RundownSlot = {
      slotId: createId(),
      templateId: t.id,
      kind: 'ue',
      name: t.name,
      vars: {},
    };
    try {
      const updated = await api.rundowns.update(activeRundown.id, {
        slots: [...activeRundown.slots, slot],
      });
      onRundownUpdated(updated);
      toast.success(`Added "${t.name}" to rundown`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="border-b border-border bg-surface-2/40 px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink-muted">UE Templates</h3>
          <p className="text-[11px] text-ink-muted">
            Channel <span className="text-ink">{channel.name}</span> · Blueprint Take In/Out
          </p>
        </div>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-ink-muted" />}
      </div>
      {items.length === 0 ? (
        <p className="text-[12px] text-ink-muted">No UE templates. Create them under UE Templates in the nav.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {items.map((t) => (
            <li
              key={t.id}
              className="flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1.5"
            >
              <Box className="h-3.5 w-3.5 text-accent" aria-hidden />
              <span className="max-w-[10rem] truncate text-[12px] font-medium">{t.name}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busyId === t.id}
                onClick={() => void play(t.id, 'takeIn')}
                title="Take In"
              >
                <Play className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busyId === t.id}
                onClick={() => void play(t.id, 'takeOut')}
                title="Take Out"
              >
                <Square className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void addToRundown(t)}
                title="Add to active rundown"
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
