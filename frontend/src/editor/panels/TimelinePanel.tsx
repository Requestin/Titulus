import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronDown, ChevronRight, Pencil, Trash2 } from 'lucide-react';
import type { AnimatableProp, Template } from '@runtime';
import { directorLocalFrame } from '@runtime';
import { Checkbox, NumberInput } from '@/components/ui/form';
import { cn } from '@/lib/cn';
import { useEditor, type Target } from '../store';
import {
  usePlayhead,
  requestContinue,
  scrubGlobalPlayhead,
  scrubLocalPlayhead,
  playheadStore,
  preparePlayStart,
  setLivePlaying,
  startBoundPlayback,
  stopBoundPlayback,
} from '../playheadStore';
import { isCrawlDirector } from '../crawlTimeline';
import { canRemoveDirector, canRenameDirector, listCuesForDirector } from '../timelineCues';
import {
  collectTracks,
  type SelectedKeyframe,
} from '../timelineTracks';
import { objectSummary as objectRange } from '../timelineSummary';
import { keyframesInMarquee, normalizeMarquee, toggleKeyframeSelection } from '../timelineMarquee';
import { CurveView } from '../timeline/CurveView';
import { TimelineTransport, TrackEditToolbar } from '../timeline/Transport';
import { ActionLane } from '../timeline/ActionLane';
import { DopeLane } from '../timeline/DopeLane';
import { SummaryBar } from '../timeline/SummaryBar';
import {
  ACTION_LANE_H,
  DIRECTOR_HDR_H,
  GROUP_HDR_H,
  HEADER_W,
  RULER_H,
  TIMELINE_ANIMATABLE_PROPS,
  buildAllDirectorsLaneLayout,
  directorLaneSpans,
  keyframeHits,
  parseTimelineDrag,
  serializeTimelineDrag,
  timelinePropLabel,
} from '../timeline/layout';

export type { SelectedKeyframe };

function objectKey(target: Target): string {
  return `${target.kind}:${target.id}`;
}

function Ruler({
  dur,
  pxPerFrame,
  playhead,
  onScrub,
}: {
  dur: number;
  pxPerFrame: number;
  playhead: number;
  onScrub: (event: ReactPointerEvent) => void;
}) {
  const step = pxPerFrame < 4 ? 50 : pxPerFrame < 10 ? 25 : 10;
  const ticks: number[] = [];
  for (let frame = 0; frame <= dur; frame += step) ticks.push(frame);
  return (
    <div
      className="sticky left-0 top-0 z-sticky cursor-pointer select-none border-b border-border bg-surface-2"
      style={{ height: RULER_H }}
      onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); onScrub(event); }}
      onPointerMove={(event) => { if (event.buttons === 1) onScrub(event); }}
    >
      {ticks.map((frame) => (
        <div
          key={frame}
          className="absolute top-0 h-full border-l border-border/60 pl-1 text-[10px] tabular-nums text-ink-faint"
          style={{ left: frame * pxPerFrame }}
        >
          {frame}
        </div>
      ))}
      <div
        className="pointer-events-none absolute top-0 z-30 h-full w-px bg-warning"
        style={{ left: playhead * pxPerFrame }}
      />
    </div>
  );
}

function untrackedPropsFor(template: Template, target: Target): AnimatableProp[] {
  const tracked = new Set(
    collectTracks(template)
      .filter((track) => track.target.kind === target.kind && track.target.id === target.id)
      .map((track) => track.prop),
  );
  const layer = target.kind === 'layer'
    ? template.layers.find((item) => item.id === target.id)
    : null;
  return TIMELINE_ANIMATABLE_PROPS.filter((prop) => {
    if (tracked.has(prop)) return false;
    if (prop === 'crawlProgress' && (!layer || layer.type !== 'crawl')) return false;
    if (prop.startsWith('gradient.weights.') && (layer?.type !== 'rect' || layer.fillMode !== 'gradient')) {
      return false;
    }
    return true;
  });
}

export function TimelinePanel() {
  const template = useEditor((state) => state.template);
  const selection = useEditor((state) => state.selection);
  const select = useEditor((state) => state.select);
  const playhead = usePlayhead((state) => state.playhead);
  const playing = usePlayhead((state) => state.playing);
  const activeDirectorId = useEditor((state) => state.activeDirectorId);
  const selectedKeyframes = useEditor((state) => state.selectedKeyframes);
  const selectedCueId = useEditor((state) => state.selectedCueId);
  const waitingContinue = usePlayhead((state) => state.waitingContinue);
  const setPlaying = useEditor((state) => state.setPlaying);
  const setActiveDirector = useEditor((state) => state.setActiveDirector);
  const addDirector = useEditor((state) => state.addDirector);
  const updateDirector = useEditor((state) => state.updateDirector);
  const removeDirector = useEditor((state) => state.removeDirector);
  const addTrackAtPlayhead = useEditor((state) => state.addTrackAtPlayhead);
  const addKeyframeAtPlayhead = useEditor((state) => state.addKeyframeAtPlayhead);
  const assignPropertyDirector = useEditor((state) => state.assignPropertyDirector);
  const assignTracksToDirector = useEditor((state) => state.assignTracksToDirector);
  const removeTrack = useEditor((state) => state.removeTrack);
  const setSelectedKeyframes = useEditor((state) => state.setSelectedKeyframes);
  const deleteSelectedKeyframes = useEditor((state) => state.deleteSelectedKeyframes);
  const moveSelectedKeyframes = useEditor((state) => state.moveSelectedKeyframes);
  const stretchObjectSummary = useEditor((state) => state.stretchObjectSummary);
  const selectCue = useEditor((state) => state.selectCue);
  const addCueAtPlayhead = useEditor((state) => state.addCueAtPlayhead);
  const removeSelectedCue = useEditor((state) => state.removeSelectedCue);
  const moveCue = useEditor((state) => state.moveCue);

  const [view, setView] = useState<'dope' | 'curve'>('dope');
  const [pxPerFrame, setPxPerFrame] = useState(6);
  const [activeTrack, setActiveTrack] = useState<{ target: Target; prop: AnimatableProp } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [collapsedDirectors, setCollapsedDirectors] = useState<Set<string>>(() => new Set());
  const [collapsedObjects, setCollapsedObjects] = useState<Set<string>>(() => new Set());
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [editingDirectorId, setEditingDirectorId] = useState<string | null>(null);
  const [directorNameDraft, setDirectorNameDraft] = useState('');
  const headersScrollRef = useRef<HTMLDivElement>(null);
  const lanesScrollRef = useRef<HTMLDivElement>(null);
  const scrollSyncRef = useRef(false);
  const pxPerFrameRef = useRef(pxPerFrame);
  pxPerFrameRef.current = pxPerFrame;
  const globalPlayhead = usePlayhead((state) => state.globalPlayhead);
  const localPlayheads = usePlayhead((state) => state.localPlayheads);

  function zoomTo(nextPx: number, anchorFrame: number) {
    const area = lanesScrollRef.current;
    setPxPerFrame((prev) => {
      const next = Math.min(24, Math.max(2, nextPx));
      if (!area || next === prev) return next;
      const anchorScreen = anchorFrame * prev - area.scrollLeft;
      requestAnimationFrame(() => {
        area.scrollLeft = Math.max(0, anchorFrame * next - anchorScreen);
      });
      return next;
    });
  }

  function frameFromClientX(clientX: number, scale = pxPerFrameRef.current): number {
    const area = lanesScrollRef.current;
    if (!area) return 0;
    const rect = area.getBoundingClientRect();
    return Math.max(0, Math.round((clientX - rect.left + area.scrollLeft) / scale));
  }

  useEffect(() => {
    const area = lanesScrollRef.current;
    if (!area || !template) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (!event.altKey) return;
      event.preventDefault();
      const currentScale = pxPerFrameRef.current;
      const zoomIn = event.deltaY < 0;
      zoomTo(currentScale + (zoomIn ? 2 : -2), frameFromClientX(event.clientX, currentScale));
    };
    area.addEventListener('wheel', onWheel, { passive: false });
    return () => area.removeEventListener('wheel', onWheel);
  }, [template]);

  if (!template) return null;
  const current = template;
  const directors = current.timeline.directors;
  const director = directors.find((item) => item.id === activeDirectorId) ?? directors[0];
  const duration = Math.max(
    1,
    current.timeline.durationFrames,
    ...directors.map((item) => item.offsetFrames + item.durationFrames),
  );
  const activeLocalDuration = director?.durationFrames ?? duration;
  const selectedTarget: Target | null = selection ? { kind: selection.kind, id: selection.id } : null;
  const allTracks = collectTracks(current);
  const layout = buildAllDirectorsLaneLayout(current, directors, collapsedDirectors, pxPerFrame, collapsedObjects);
  const spans = directorLaneSpans(layout.rows);
  const untrackedProps = selectedTarget ? untrackedPropsFor(current, selectedTarget) : [];
  const activeTrackResolved = activeTrack
    && allTracks.some((track) => track.target.id === activeTrack.target.id && track.prop === activeTrack.prop)
    ? activeTrack
    : (selectedTarget
      ? allTracks.find((track) => track.target.kind === selectedTarget.kind && track.target.id === selectedTarget.id) ?? allTracks[0] ?? null
      : allTracks[0] ?? null);

  function zoomBy(delta: number) {
    zoomTo(pxPerFrame + delta, globalPlayhead);
  }

  function toggleObjectCollapsed(target: Target) {
    const key = objectKey(target);
    setCollapsedObjects((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function syncScroll(from: 'headers' | 'lanes') {
    if (view !== 'dope' || scrollSyncRef.current) return;
    const headers = headersScrollRef.current;
    const lanes = lanesScrollRef.current;
    if (!headers || !lanes) return;
    scrollSyncRef.current = true;
    if (from === 'headers') lanes.scrollTop = headers.scrollTop;
    else headers.scrollTop = lanes.scrollTop;
    scrollSyncRef.current = false;
  }

  function scrubFromEvent(event: ReactPointerEvent) {
    const frame = Math.min(duration, frameFromClientX(event.clientX));
    scrubGlobalPlayhead(frame, directors, director?.id ?? activeDirectorId);
    setPlaying(false);
  }

  function scrubLocalFromEvent(directorId: string, durationFrames: number, event: ReactPointerEvent | PointerEvent) {
    const frame = Math.min(durationFrames, frameFromClientX(event.clientX));
    scrubLocalPlayhead(directorId, frame, durationFrames, director?.id ?? activeDirectorId);
    setPlaying(false);
  }

  function startLocalPlayheadDrag(directorId: string, durationFrames: number, event: ReactPointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    scrubLocalFromEvent(directorId, durationFrames, event);
    const onMove = (move: PointerEvent) => scrubLocalFromEvent(directorId, durationFrames, move);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function togglePlay() {
    if (playheadStore.getState().playing) {
      stopBoundPlayback();
      setLivePlaying(false);
      setPlaying(false);
      return;
    }
    preparePlayStart(directors, director?.id ?? activeDirectorId);
    startBoundPlayback();
    setPlaying(true);
  }

  function laneFrameFromEvent(event: ReactPointerEvent, _laneEl: Element): number {
    return Math.min(activeLocalDuration, frameFromClientX(event.clientX));
  }

  function handleDrop(directorId: string, data: string) {
    const payload = parseTimelineDrag(data);
    if (!payload) return;
    if (payload.type === 'track') {
      assignTracksToDirector([{ target: payload.target, prop: payload.prop }], directorId);
      return;
    }
    assignTracksToDirector(
      collectTracks(current).filter((item) => (
        item.target.kind === payload.target.kind && item.target.id === payload.target.id
      )),
      directorId,
    );
  }

  function handleAddKeyframe() {
    if (!activeTrackResolved) return;
    addKeyframeAtPlayhead(activeTrackResolved.target, activeTrackResolved.prop);
  }

  function toggleDirectorCollapsed(directorId: string) {
    setCollapsedDirectors((prev) => {
      const next = new Set(prev);
      if (next.has(directorId)) next.delete(directorId);
      else next.add(directorId);
      return next;
    });
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if ((event.key === 'Delete' || event.key === 'Backspace') && selectedKeyframes.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      deleteSelectedKeyframes();
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selectedCueId) {
      event.preventDefault();
      event.stopPropagation();
      removeSelectedCue();
    }
  }

  function moveSummary(target: Target, delta: number) {
    const summary = objectRange(current, target);
    if (!summary || delta === 0) return;
    setSelectedKeyframes(summary.keys);
    moveSelectedKeyframes(delta);
  }

  const timelineWidth = Math.max(duration * pxPerFrame + 24, 100);
  const hits = keyframeHits(current, layout.rows, pxPerFrame);

  return (
    <div className="flex h-full flex-col bg-surface" tabIndex={0} onKeyDown={handleKeyDown}>
      <TimelineTransport
        playing={playing}
        playhead={playhead}
        duration={activeLocalDuration}
        view={view}
        canContinue={waitingContinue}
        onTogglePlay={togglePlay}
        onGoToStart={() => {
          stopBoundPlayback();
          setLivePlaying(false);
          scrubGlobalPlayhead(
            director?.offsetFrames ?? 0,
            directors,
            director?.id ?? activeDirectorId,
          );
          setPlaying(false);
        }}
        onContinue={requestContinue}
        onGoToEnd={() => {
          stopBoundPlayback();
          setLivePlaying(false);
          scrubGlobalPlayhead(
            (director?.offsetFrames ?? 0) + (director?.durationFrames ?? duration),
            directors,
            director?.id ?? activeDirectorId,
          );
          setPlaying(false);
        }}
        onView={setView}
        onZoomOut={() => zoomBy(-2)}
        onZoomIn={() => zoomBy(2)}
      />

      {director && (
        <div className="flex h-8 shrink-0 items-center gap-3 border-b border-border px-2 text-[12px] text-ink-muted">
          <span className="max-w-[8rem] truncate font-semibold uppercase tracking-wide text-ink" title={director.name}>
            {director.name}
          </span>
          <label className="flex items-center gap-1.5">Dur
            <NumberInput
              value={director.durationFrames}
              min={1}
              step={1}
              disabled={isCrawlDirector(current, director.id)}
              title={isCrawlDirector(current, director.id) ? 'Считается из текста, размера бокса и Speed' : undefined}
              aria-label={`${director.name} duration`}
              onChange={(value) => updateDirector(director.id, { durationFrames: Math.max(1, Math.round(value)) })}
              className="h-6 w-16"
            />
          </label>
          <label className="flex items-center gap-1.5">Offset
            <NumberInput
              value={director.offsetFrames}
              min={0}
              step={1}
              aria-label={`${director.name} offset`}
              onChange={(value) => updateDirector(director.id, { offsetFrames: Math.max(0, Math.round(value)) })}
              className="h-6 w-16"
            />
          </label>
          <Checkbox label="loop" checked={director.loop} onChange={(value) => updateDirector(director.id, { loop: value })} />
          <Checkbox label="swing" checked={director.swing} onChange={(value) => updateDirector(director.id, { swing: value })} />
          <Checkbox label="autostart" checked={director.autostart} onChange={(value) => updateDirector(director.id, { autostart: value })} />
        </div>
      )}

      <TrackEditToolbar
        canAddTrack={Boolean(selectedTarget) && untrackedProps.length > 0}
        canAddKeyframe={Boolean(activeTrackResolved)}
        canDeleteKeyframes={selectedKeyframes.length > 0}
        canAddCue={Boolean(director)}
        canDeleteCue={Boolean(selectedCueId)}
        addOpen={addOpen}
        untrackedProps={untrackedProps}
        propLabel={timelinePropLabel}
        onToggleAdd={() => setAddOpen((value) => !value)}
        onAddProp={(prop) => {
          if (!selectedTarget) return;
          addTrackAtPlayhead(selectedTarget, prop);
          assignPropertyDirector(selectedTarget, prop, director?.id ?? 'default');
          setActiveTrack({ target: selectedTarget, prop });
          setAddOpen(false);
        }}
        onAddDirector={addDirector}
        onAddKeyframe={handleAddKeyframe}
        onDeleteKeyframes={deleteSelectedKeyframes}
        onAddCue={() => {
          if (director) {
            setCollapsedDirectors((prev) => {
              if (!prev.has(director.id)) return prev;
              const next = new Set(prev);
              next.delete(director.id);
              return next;
            });
          }
          addCueAtPlayhead();
        }}
        onDeleteCue={removeSelectedCue}
      />

      <div className="flex min-h-0 flex-1">
        <div className="flex shrink-0 flex-col border-r border-border" style={{ width: HEADER_W }}>
          <div
            ref={headersScrollRef}
            className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
            onScroll={() => syncScroll('headers')}
          >
            <div style={{ height: RULER_H }} className="sticky top-0 shrink-0 border-b border-border bg-surface-2" />
            {directors.length === 0 ? (
              <p className="p-3 text-[12px] text-ink-faint">
                Add a director with +D.
              </p>
            ) : (
              layout.rows.map((row) => {
                if (row.kind === 'director') {
                  const host = directors.find((item) => item.id === row.directorId);
                  const active = row.directorId === (director?.id ?? '');
                  const removable = canRemoveDirector(directors, row.directorId);
                  const renameable = host ? canRenameDirector(host) : false;
                  const editing = editingDirectorId === row.directorId;
                  return (
                    <div
                      key={`d:${row.directorId}`}
                      style={{ height: DIRECTOR_HDR_H }}
                      className={cn(
                        'flex w-full items-center gap-0.5 border-b border-border/50 px-1 text-[11px] font-semibold uppercase tracking-wide',
                        active ? 'bg-primary/15 text-ink' : 'bg-surface-2 text-ink-muted',
                      )}
                      onClick={() => setActiveDirector(row.directorId)}
                      onDragOver={(event) => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'move';
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        handleDrop(row.directorId, event.dataTransfer.getData('text/plain'));
                      }}
                    >
                      <button
                        type="button"
                        aria-label={row.collapsed ? `Expand ${row.label}` : `Collapse ${row.label}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleDirectorCollapsed(row.directorId);
                        }}
                        className="grid h-6 w-6 shrink-0 place-items-center hover:text-ink"
                      >
                        {row.collapsed
                          ? <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                          : <ChevronDown className="h-3.5 w-3.5" aria-hidden />}
                      </button>
                      {editing ? (
                        <input
                          value={directorNameDraft}
                          autoFocus
                          aria-label={`Rename ${row.label}`}
                          className="min-w-0 flex-1 rounded border border-border bg-surface px-1 text-[11px] font-semibold uppercase text-ink"
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => setDirectorNameDraft(event.target.value)}
                          onBlur={() => {
                            const name = directorNameDraft.trim();
                            if (name) updateDirector(row.directorId, { name });
                            setEditingDirectorId(null);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') event.currentTarget.blur();
                            if (event.key === 'Escape') setEditingDirectorId(null);
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setActiveDirector(row.directorId);
                          }}
                          className="min-w-0 flex-1 truncate text-left hover:text-ink"
                        >
                          {row.label}
                        </button>
                      )}
                      {renameable && (
                        <button
                          type="button"
                          title="Rename director"
                          aria-label={`Rename ${row.label}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setActiveDirector(row.directorId);
                            setDirectorNameDraft(row.label);
                            setEditingDirectorId(row.directorId);
                          }}
                          className="grid h-6 w-6 shrink-0 place-items-center rounded text-ink-faint hover:bg-surface hover:text-ink"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {removable && (
                        <button
                          type="button"
                          title="Remove director"
                          aria-label={`Remove ${row.label}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            removeDirector(row.directorId);
                          }}
                          className="grid h-6 w-6 shrink-0 place-items-center rounded text-ink-faint hover:bg-surface hover:text-danger"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  );
                }
                if (row.kind === 'action') {
                  return (
                    <div
                      key={`a:${row.directorId}`}
                      style={{ height: ACTION_LANE_H }}
                      className="flex items-center border-b border-border/40 pl-7 pr-1 text-[11px] font-semibold uppercase tracking-wide text-ink-faint"
                    >
                      Action
                    </div>
                  );
                }
                if (row.kind === 'group') {
                  const groupSelected = selectedTarget?.kind === row.target.kind && selectedTarget.id === row.target.id;
                  return (
                    <div
                      key={`g:${row.target.kind}:${row.target.id}:${row.y}`}
                      style={{ height: GROUP_HDR_H }}
                      className={cn(
                        'flex w-full items-center gap-0.5 px-1 pl-3 text-[11px] font-semibold',
                        groupSelected ? 'bg-primary/10 text-ink' : 'text-ink-muted hover:bg-surface-2',
                      )}
                    >
                      <button
                        type="button"
                        aria-label={row.collapsed ? `Expand ${row.label}` : `Collapse ${row.label}`}
                        onClick={() => toggleObjectCollapsed(row.target)}
                        className="grid h-5 w-5 shrink-0 place-items-center hover:text-ink"
                      >
                        {row.collapsed
                          ? <ChevronRight className="h-3 w-3" aria-hidden />
                          : <ChevronDown className="h-3 w-3" aria-hidden />}
                      </button>
                      <button
                        type="button"
                        draggable
                        onDragStart={(event) => {
                          event.dataTransfer.setData('text/plain', serializeTimelineDrag({ type: 'object', target: row.target }));
                        }}
                        onClick={() => select(row.target)}
                        className="min-w-0 flex-1 truncate text-left"
                      >
                        {row.label}
                      </button>
                    </div>
                  );
                }
                if (row.kind !== 'track') return null;
                const isActive = activeTrackResolved
                  && activeTrackResolved.target.id === row.target.id
                  && activeTrackResolved.prop === row.prop;
                const objectSelected = selectedTarget?.kind === row.target.kind && selectedTarget.id === row.target.id;
                return (
                  <div
                    key={`t:${row.target.kind}:${row.target.id}:${row.prop}:${row.y}`}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData('text/plain', serializeTimelineDrag({
                        type: 'track',
                        target: row.target,
                        prop: row.prop,
                      }));
                    }}
                    style={{ height: row.height }}
                    className={cn(
                      'flex items-center gap-0.5 border-b border-border/40 pl-5 pr-1',
                      isActive ? 'bg-primary/15 text-ink' : objectSelected ? 'bg-primary/10 text-ink' : 'text-ink-muted hover:bg-surface-2',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        select(row.target);
                        setActiveTrack({ target: row.target, prop: row.prop });
                        if (view === 'dope') setView('curve');
                      }}
                      className="min-w-0 flex-1 truncate text-left text-[12px] tabular-nums"
                    >
                      {timelinePropLabel(row.prop)}
                    </button>
                    <button
                      type="button"
                      title="Remove track"
                      onClick={() => removeTrack(row.target, row.prop)}
                      className="grid h-6 w-6 shrink-0 place-items-center rounded text-ink-faint hover:bg-surface hover:text-danger"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div
          ref={lanesScrollRef}
          className="relative min-h-0 min-w-0 flex-1 overflow-auto"
          onScroll={() => syncScroll('lanes')}
          onPointerDown={(event) => {
            if (view !== 'dope') return;
            if ((event.target as HTMLElement).closest('[data-kf],[data-summary],[data-playhead],[data-action-lane]')) return;
            const area = lanesScrollRef.current;
            if (!area) return;
            const content = area.firstElementChild as HTMLElement | null;
            if (!content) return;
            const rect = content.getBoundingClientRect();
            const x = event.clientX - rect.left + area.scrollLeft;
            const y = event.clientY - rect.top + area.scrollTop - RULER_H;
            if (y < 0) return;
            event.preventDefault();
            const start = { x0: x, y0: y, x1: x, y1: y };
            setMarquee(start);
            const onMove = (move: PointerEvent) => {
              setMarquee({
                ...start,
                x1: move.clientX - rect.left + area.scrollLeft,
                y1: move.clientY - rect.top + area.scrollTop - RULER_H,
              });
            };
            const onUp = (up: PointerEvent) => {
              const next = {
                ...start,
                x1: up.clientX - rect.left + area.scrollLeft,
                y1: up.clientY - rect.top + area.scrollTop - RULER_H,
              };
              const rectBox = normalizeMarquee(next.x0, next.y0, next.x1, next.y1);
              if (Math.abs(rectBox.right - rectBox.left) > 3 || Math.abs(rectBox.bottom - rectBox.top) > 3) {
                setSelectedKeyframes(keyframesInMarquee(hits, rectBox));
              }
              setMarquee(null);
              window.removeEventListener('pointermove', onMove);
              window.removeEventListener('pointerup', onUp);
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
          }}
        >
          <div
            style={{
              width: timelineWidth,
              minHeight: '100%',
              height: RULER_H + layout.height,
            }}
            className="relative"
          >
            <Ruler
              dur={duration}
              pxPerFrame={pxPerFrame}
              playhead={view === 'curve' ? playhead : globalPlayhead}
              onScrub={scrubFromEvent}
            />
            {view === 'dope' && layout.rows.map((row) => {
              if (row.kind === 'director') {
                const dir = directors.find((item) => item.id === row.directorId);
                return (
                  <div
                    key={`lane-d:${row.directorId}`}
                    className="relative border-b border-border/40 bg-surface-2/80"
                    style={{ height: DIRECTOR_HDR_H }}
                    onPointerDown={(event) => {
                      if (!dir) return;
                      if ((event.target as HTMLElement).closest('[data-playhead]')) return;
                      startLocalPlayheadDrag(dir.id, dir.durationFrames, event);
                    }}
                  />
                );
              }
              if (row.kind === 'action') {
                const dir = directors.find((item) => item.id === row.directorId);
                return (
                  <ActionLane
                    key={`lane-a:${row.directorId}`}
                    cues={listCuesForDirector(current.timeline.cues, row.directorId)}
                    duration={dir?.durationFrames ?? duration}
                    pxPerFrame={pxPerFrame}
                    selectedCueId={selectedCueId}
                    onSelect={selectCue}
                    onMove={moveCue}
                  />
                );
              }
              if (row.kind === 'group') {
                return (
                  <div key={`lane-g:${row.target.id}:${row.y}`} className="relative border-b border-border/25 bg-surface/50" style={{ height: GROUP_HDR_H }}>
                    <SummaryBar
                      target={row.target}
                      start={row.start}
                      end={row.end}
                      pxPerFrame={pxPerFrame}
                      onMove={moveSummary}
                      onStretch={stretchObjectSummary}
                    />
                  </div>
                );
              }
              return (
                <DopeLane
                  key={`lane-t:${row.target.id}:${row.prop}:${row.y}`}
                  target={row.target}
                  prop={row.prop}
                  pxPerFrame={pxPerFrame}
                  frameFromEvent={laneFrameFromEvent}
                  selected={selectedKeyframes}
                  onSelect={(keyframe, mode) => setSelectedKeyframes(toggleKeyframeSelection(selectedKeyframes, keyframe, mode))}
                  onMoveSelected={moveSelectedKeyframes}
                />
              );
            })}
            {view === 'curve' && activeTrackResolved && (
              <CurveView
                target={activeTrackResolved.target}
                prop={activeTrackResolved.prop}
                pxPerFrame={pxPerFrame}
                dur={duration}
                frameFromEvent={laneFrameFromEvent}
                selected={selectedKeyframes}
                onSelect={(keyframe) => setSelectedKeyframes([keyframe])}
              />
            )}
            {view === 'curve' && !activeTrackResolved && (
              <div className="p-3 text-[12px] text-ink-faint">Add a track to edit its curve.</div>
            )}
            <div
              className="pointer-events-none absolute z-50 w-px bg-warning/90"
              style={{
                left: (view === 'curve' ? playhead : globalPlayhead) * pxPerFrame,
                top: RULER_H,
                bottom: 0,
              }}
              title={`Playhead ${Math.round(view === 'curve' ? playhead : globalPlayhead)}`}
            />
            {view === 'dope' && spans.map((span) => {
              const dir = directors.find((item) => item.id === span.directorId);
              if (!dir) return null;
              const local = localPlayheads[dir.id]
                ?? directorLocalFrame(dir, globalPlayhead)
                ?? 0;
              return (
                <div
                  key={`ph:${span.directorId}`}
                  data-playhead={dir.id}
                  className="absolute z-[60] w-2 -translate-x-1/2 cursor-ew-resize"
                  style={{
                    left: local * pxPerFrame,
                    top: RULER_H + span.y,
                    height: span.height,
                  }}
                  title={`${dir.name} local ${Math.round(local)}`}
                  onPointerDown={(event) => startLocalPlayheadDrag(dir.id, dir.durationFrames, event)}
                >
                  <div className="mx-auto h-full w-px bg-live" />
                </div>
              );
            })}
            {marquee && (
              <div
                className="pointer-events-none absolute z-20 border border-live/70 bg-live/10"
                style={{
                  left: Math.min(marquee.x0, marquee.x1),
                  top: RULER_H + Math.min(marquee.y0, marquee.y1),
                  width: Math.abs(marquee.x1 - marquee.x0),
                  height: Math.abs(marquee.y1 - marquee.y0),
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
