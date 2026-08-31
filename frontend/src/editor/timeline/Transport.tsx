import { Activity, ChevronsRight, ListTree, Pause, Play, Square, Trash2, Plus } from 'lucide-react';
import type { AnimatableProp } from '@runtime';
import { cn } from '@/lib/cn';

export function TimelineTransport({
  playing,
  playhead,
  duration,
  view,
  canContinue,
  onTogglePlay,
  onStop,
  onContinue,
  onView,
  onZoomOut,
  onZoomIn,
}: {
  playing: boolean;
  playhead: number;
  duration: number;
  view: 'dope' | 'curve';
  canContinue: boolean;
  onTogglePlay: () => void;
  onStop: () => void;
  onContinue: () => void;
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
        disabled={!canContinue}
        aria-disabled={!canContinue}
        title="Continue"
        onClick={onContinue}
        className={cn(
          'grid h-7 w-7 place-items-center rounded-md',
          canContinue ? 'text-ink hover:bg-surface-2' : 'cursor-not-allowed text-ink-faint opacity-40',
        )}
      >
        <ChevronsRight className="h-4 w-4" />
      </button>
      <span className="w-24 text-center text-[12px] tabular-nums text-ink-muted">
        {Math.round(playhead)} / {duration}
      </span>
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

export function TrackEditToolbar({
  canAddTrack,
  canAddKeyframe,
  canDeleteKeyframes,
  canAddCue,
  canDeleteCue,
  addOpen,
  untrackedProps,
  propLabel,
  onToggleAdd,
  onAddProp,
  onAddDirector,
  onAddKeyframe,
  onDeleteKeyframes,
  onAddCue,
  onDeleteCue,
}: {
  canAddTrack: boolean;
  canAddKeyframe: boolean;
  canDeleteKeyframes: boolean;
  canAddCue: boolean;
  canDeleteCue: boolean;
  addOpen: boolean;
  untrackedProps: AnimatableProp[];
  propLabel: (prop: AnimatableProp) => string;
  onToggleAdd: () => void;
  onAddProp: (prop: AnimatableProp) => void;
  onAddDirector: () => void;
  onAddKeyframe: () => void;
  onDeleteKeyframes: () => void;
  onAddCue: () => void;
  onDeleteCue: () => void;
}) {
  return (
    <div className="relative flex h-8 shrink-0 items-center gap-1 border-b border-border px-2">
      <button
        type="button"
        onClick={onToggleAdd}
        disabled={!canAddTrack}
        className="flex items-center gap-1 rounded-md border border-dashed border-border px-1.5 py-0.5 text-[12px] text-ink-muted hover:text-ink disabled:opacity-40"
      >
        <Plus className="h-3.5 w-3.5" /> Track
      </button>
      {addOpen && (
        <>
          <div className="fixed inset-0 z-dropdown" onClick={onToggleAdd} />
          <div className="absolute left-2 top-full z-dropdown mt-1 grid max-h-48 w-32 grid-cols-2 gap-0.5 overflow-auto rounded-md border border-border bg-surface-2 p-1 shadow-xl">
            {untrackedProps.map((prop) => (
              <button
                key={prop}
                type="button"
                onClick={() => onAddProp(prop)}
                className="rounded px-1 py-1 text-left text-[11px] text-ink hover:bg-surface"
              >
                {propLabel(prop)}
              </button>
            ))}
          </div>
        </>
      )}
      <button
        type="button"
        onClick={onAddDirector}
        title="Add director"
        className="rounded-md px-1.5 text-[11px] font-semibold text-ink-muted hover:bg-surface-2 hover:text-ink"
      >
        +D
      </button>
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
      <button
        type="button"
        disabled={!canAddCue}
        onClick={onAddCue}
        title="+A"
        className={cn(
          'rounded-md px-1.5 text-[11px] font-semibold',
          canAddCue ? 'text-ink-muted hover:bg-surface-2 hover:text-ink' : 'cursor-not-allowed text-ink-faint opacity-40',
        )}
      >
        +A
      </button>
      <button
        type="button"
        disabled={!canDeleteCue}
        onClick={onDeleteCue}
        title="-A"
        className={cn(
          'rounded-md px-1.5 text-[11px] font-semibold',
          canDeleteCue ? 'text-ink-muted hover:bg-surface-2 hover:text-danger' : 'cursor-not-allowed text-ink-faint opacity-40',
        )}
      >
        -A
      </button>
    </div>
  );
}

