import { Activity, ChevronsRight, ListTree, Pause, Play, Plus, Square, Trash2 } from 'lucide-react';
import { cn } from '@/lib/cn';

export function TimelineTransport({
  playing,
  playhead,
  duration,
  view,
  canAddKeyframe,
  canDeleteKeyframes,
  onTogglePlay,
  onStop,
  onContinue,
  onAddKeyframe,
  onDeleteKeyframes,
  onView,
  onZoomOut,
  onZoomIn,
}: {
  playing: boolean;
  playhead: number;
  duration: number;
  view: 'dope' | 'curve';
  canAddKeyframe: boolean;
  canDeleteKeyframes: boolean;
  onTogglePlay: () => void;
  onStop: () => void;
  onContinue?: () => void;
  onAddKeyframe: () => void;
  onDeleteKeyframes: () => void;
  onView: (view: 'dope' | 'curve') => void;
  onZoomOut: () => void;
  onZoomIn: () => void;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
      <button
        type="button"
        onClick={onStop}
        className="grid h-7 w-7 place-items-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink"
        title="Go to start"
      >
        <Square className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onTogglePlay}
        className="grid h-7 w-7 place-items-center rounded-md text-ink hover:bg-surface-2"
        title={playing ? 'Pause' : 'Play'}
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </button>
      <button
        type="button"
        disabled
        aria-disabled="true"
        title="Continue"
        onClick={onContinue}
        className="grid h-7 w-7 place-items-center rounded-md text-ink-faint opacity-40"
      >
        <ChevronsRight className="h-4 w-4" />
      </button>
      <span className="w-24 text-center text-[12px] tabular-nums text-ink-muted">
        {Math.round(playhead)} / {duration}
      </span>
      <div className="mx-1 h-5 w-px bg-border" />
      <button
        type="button"
        disabled={!canAddKeyframe}
        onClick={onAddKeyframe}
        title="+K"
        className={cn(
          'rounded-md px-1.5 text-[11px] font-semibold',
          canAddKeyframe ? 'text-ink-muted hover:bg-surface-2 hover:text-ink' : 'cursor-not-allowed text-ink-faint opacity-40',
        )}
      >
        +K
      </button>
      <button
        type="button"
        disabled={!canDeleteKeyframes}
        onClick={onDeleteKeyframes}
        title="-K"
        className={cn(
          'rounded-md px-1.5 text-[11px] font-semibold',
          canDeleteKeyframes ? 'text-ink-muted hover:bg-surface-2 hover:text-danger' : 'cursor-not-allowed text-ink-faint opacity-40',
        )}
      >
        -K
      </button>
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={() => onView('dope')}
          className={cn('grid h-7 w-7 place-items-center rounded-md', view === 'dope' ? 'bg-primary/20 text-ink' : 'text-ink-muted hover:bg-surface-2')}
          title="Dope sheet"
        >
          <ListTree className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => onView('curve')}
          className={cn('grid h-7 w-7 place-items-center rounded-md', view === 'curve' ? 'bg-primary/20 text-ink' : 'text-ink-muted hover:bg-surface-2')}
          title="Curve editor"
        >
          <Activity className="h-4 w-4" />
        </button>
        <button type="button" onClick={onZoomOut} className="px-1.5 text-ink-muted hover:text-ink" title="Zoom out">-</button>
        <button type="button" onClick={onZoomIn} className="px-1.5 text-ink-muted hover:text-ink" title="Zoom in">+</button>
      </div>
    </div>
  );
}

export function DirectorToolbar({
  onAdd,
  canRemove,
  onRemove,
}: {
  onAdd: () => void;
  canRemove: boolean;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={onAdd}
        className="grid h-7 w-7 place-items-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink"
        title="+D"
      >
        <Plus className="h-4 w-4" />
      </button>
      {canRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="grid h-7 w-7 place-items-center rounded-md text-ink-faint hover:text-danger"
          title="Remove director"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
