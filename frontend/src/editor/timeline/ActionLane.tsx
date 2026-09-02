import { useState } from 'react';
import type { TimelineCue } from '@runtime';
import { cn } from '@/lib/cn';
import { ACTION_LANE_H } from './layout';
import { effectiveCueFrame } from '../timelineCues';

export function ActionLane({
  cues,
  duration,
  pxPerFrame,
  selectedCueId,
  onSelect,
  onMove,
}: {
  cues: TimelineCue[];
  duration: number;
  pxPerFrame: number;
  selectedCueId: string | null;
  onSelect: (cueId: string) => void;
  onMove: (cueId: string, effectiveFrame: number) => void;
}) {
  const [drag, setDrag] = useState<{ id: string; frame: number } | null>(null);

  return (
    <div
      className="relative border-b border-border/60 bg-surface-2/70"
      style={{ height: ACTION_LANE_H }}
      data-action-lane=""
    >
      {cues.map((cue) => {
        const base = effectiveCueFrame(cue, duration);
        const frame = drag?.id === cue.id ? drag.frame : base;
        return (
          <button
            key={cue.id}
            type="button"
            title={cue.name.trim() || undefined}
            onPointerDown={(event) => {
              event.stopPropagation();
              event.preventDefault();
              onSelect(cue.id);
              const origin = event.clientX;
              const start = base;
              const onMovePtr = (move: PointerEvent) => {
                const delta = Math.round((move.clientX - origin) / pxPerFrame);
                setDrag({ id: cue.id, frame: Math.max(0, Math.min(duration, start + delta)) });
              };
              const onUp = (up: PointerEvent) => {
                const delta = Math.round((up.clientX - origin) / pxPerFrame);
                const next = Math.max(0, Math.min(duration, start + delta));
                if (next !== start) onMove(cue.id, next);
                setDrag(null);
                window.removeEventListener('pointermove', onMovePtr);
                window.removeEventListener('pointerup', onUp);
              };
              window.addEventListener('pointermove', onMovePtr);
              window.addEventListener('pointerup', onUp);
            }}
            className={cn(
              'absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border',
              selectedCueId === cue.id
                ? 'border-warning bg-warning'
                : 'border-warning/80 bg-warning/80 hover:bg-warning',
            )}
            style={{ left: frame * pxPerFrame }}
          />
        );
      })}
    </div>
  );
}
