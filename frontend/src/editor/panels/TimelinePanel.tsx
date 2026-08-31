import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import type { AnimatableProp, Template, TimelineDirector } from '@runtime';
import { Checkbox, NumberInput } from '@/components/ui/form';
import { cn } from '@/lib/cn';
import { useEditor, type Target } from '../store';
import { requestContinue, usePlayhead } from '../playheadStore';
import { isCrawlDirector } from '../crawlTimeline';
import { canRemoveDirector, listCuesForDirector } from '../timelineCues';
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

function directorLocalPlayhead(
  director: TimelineDirector,
  active: TimelineDirector | undefined,
  activeLocal: number,
): number {
  const global = (active?.offsetFrames ?? 0) + activeLocal;
  return Math.max(0, Math.min(director.durationFrames, global - director.offsetFrames));
}

function Ruler({
  dur,
  pxPerFrame,
  onScrub,
}: {
  dur: number;
  pxPerFrame: number;
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
  const setPlayhead = useEditor((state) => state.setPlayhead);
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
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const headersScrollRef = useRef<HTMLDivElement>(null);
  const lanesScrollRef = useRef<HTMLDivElement>(null);
  const scrollSyncRef = useRef(false);

  if (!template) return null;
  const current = template;
  const directors = current.timeline.directors;
  const director = directors.find((item) => item.id === activeDirectorId) ?? directors[0];
  const duration = Math.max(1, ...directors.map((item) => item.durationFrames));
  const selectedTarget: Target | null = selection ? { kind: selection.kind, id: selection.id } : null;
  const allTracks = collectTracks(current);
  const layout = buildAllDirectorsLaneLayout(current, directors, collapsedDirectors, pxPerFrame);
  const spans = directorLaneSpans(layout.rows);
  const untrackedProps = selectedTarget ? untrackedPropsFor(current, selectedTarget) : [];
  const activeTrackResolved = activeTrack
    && allTracks.some((track) => track.target.id === activeTrack.target.id && track.prop === activeTrack.prop)
    ? activeTrack
    : (selectedTarget
      ? allTracks.find((track) => track.target.kind === selectedTarget.kind && track.target.id === selectedTarget.id) ?? allTracks[0] ?? null
      : allTracks[0] ?? null);

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

  function xToFrame(x: number) { return Math.max(0, Math.round(x / pxPerFrame)); }

  function scrubFromEvent(event: ReactPointerEvent) {
    const area = lanesScrollRef.current;
    if (!area) return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setPlaying(false);
    setPlayhead(Math.min(duration, xToFrame(event.clientX - rect.left + area.scrollLeft)));
  }

  function laneFrameFromEvent(event: ReactPointerEvent, laneEl: Element): number {
    const area = lanesScrollRef.current;
    const rect = laneEl.getBoundingClientRect();
    return Math.min(duration, Math.max(0, Math.round((event.clientX - rect.left + (area?.scrollLeft ?? 0)) / pxPerFrame)));
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
        duration={duration}
        view={view}
        canContinue={waitingContinue}
        onTogglePlay={() => setPlaying(!playing)}
        onStop={() => { setPlaying(false); setPlayhead(0); }}
        onContinue={requestContinue}
        onView={setView}
        onZoomOut={() => setPxPerFrame((value) => Math.max(2, value - 2))}
        onZoomIn={() => setPxPerFrame((value) => Math.min(24, value + 2))}
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
        onAddCue={addCueAtPlayhead}
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
            <div
              style={{ height: ACTION_LANE_H }}
              className="flex items-center px-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint"
            >
              Actions
            </div>
            {directors.length === 0 ? (
              <p className="p-3 text-[12px] text-ink-faint">
                Add a director with +D.
              </p>
            ) : (
              layout.rows.map((row) => {
                if (row.kind === 'director') {
                  const active = row.directorId === (director?.id ?? '');
                  const removable = canRemoveDirector(directors, row.directorId);
                  return (
                    <div
                      key={`d:${row.directorId}`}
                      style={{ height: DIRECTOR_HDR_H }}
                      className={cn(
                        'flex w-full items-center gap-0.5 border-b border-border/50 px-1 text-[11px] font-semibold uppercase tracking-wide',
                        active ? 'bg-primary/15 text-ink' : 'bg-surface-2 text-ink-muted',
                      )}
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
                        onClick={() => toggleDirectorCollapsed(row.directorId)}
                        className="grid h-6 w-6 shrink-0 place-items-center hover:text-ink"
                      >
                        {row.collapsed
                          ? <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                          : <ChevronDown className="h-3.5 w-3.5" aria-hidden />}
                      </button>
                      <button
                        type="button"
                        onClick={() => setActiveDirector(row.directorId)}
                        className="min-w-0 flex-1 truncate text-left hover:text-ink"
                      >
                        {row.label}
                      </button>
                      {removable && (
                        <button
                          type="button"
                          title="Remove director"
                          aria-label={`Remove ${row.label}`}
                          onClick={() => removeDirector(row.directorId)}
                          className="grid h-6 w-6 shrink-0 place-items-center rounded text-ink-faint hover:bg-surface hover:text-danger"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  );
                }
                if (row.kind === 'group') {
                  const groupSelected = selectedTarget?.kind === row.target.kind && selectedTarget.id === row.target.id;
                  return (
                    <button
                      key={`g:${row.target.kind}:${row.target.id}:${row.y}`}
                      type="button"
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData('text/plain', serializeTimelineDrag({ type: 'object', target: row.target }));
                      }}
                      onClick={() => select(row.target)}
                      style={{ height: GROUP_HDR_H }}
                      className={cn(
                        'flex w-full items-center gap-1 px-2 pl-4 text-left text-[11px] font-semibold',
                        groupSelected ? 'bg-primary/10 text-ink' : 'text-ink-muted hover:bg-surface-2',
                      )}
                    >
                      <span className="truncate">{row.label}</span>
                    </button>
                  );
                }
                const isActive = activeTrackResolved
                  && activeTrackResolved.target.id === row.target.id
                  && activeTrackResolved.prop === row.prop;
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
                      isActive ? 'bg-primary/15 text-ink' : 'text-ink-muted hover:bg-surface-2',
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
        >
          <div
            style={{ width: timelineWidth, minHeight: RULER_H + ACTION_LANE_H + layout.height }}
            className="relative"
            onPointerDown={(event) => {
              if (view !== 'dope') return;
              if ((event.target as HTMLElement).closest('[data-kf],[data-summary]')) return;
              const rect = event.currentTarget.getBoundingClientRect();
              const area = lanesScrollRef.current;
              const x = event.clientX - rect.left + (area?.scrollLeft ?? 0);
              const y = event.clientY - rect.top + (area?.scrollTop ?? 0) - RULER_H;
              if (y < 0) return;
              const start = { x0: x, y0: y, x1: x, y1: y };
              setMarquee(start);
              const onMove = (move: PointerEvent) => {
                setMarquee({
                  ...start,
                  x1: move.clientX - rect.left + (area?.scrollLeft ?? 0),
                  y1: move.clientY - rect.top + (area?.scrollTop ?? 0) - RULER_H,
                });
              };
              const onUp = (up: PointerEvent) => {
                const next = {
                  ...start,
                  x1: up.clientX - rect.left + (area?.scrollLeft ?? 0),
                  y1: up.clientY - rect.top + (area?.scrollTop ?? 0) - RULER_H,
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
            <Ruler dur={duration} pxPerFrame={pxPerFrame} onScrub={scrubFromEvent} />
            <ActionLane
              cues={listCuesForDirector(current.timeline.cues, director?.id ?? 'default')}
              duration={duration}
              pxPerFrame={pxPerFrame}
              selectedCueId={selectedCueId}
              onSelect={selectCue}
              onMove={moveCue}
            />
            {view === 'dope' && spans.map((span) => {
              const dir = directors.find((item) => item.id === span.directorId);
              if (!dir) return null;
              const local = directorLocalPlayhead(dir, director, playhead);
              return (
                <div
                  key={`ph:${span.directorId}`}
                  className="pointer-events-none absolute z-20 w-px bg-live"
                  style={{
                    left: local * pxPerFrame,
                    top: RULER_H + ACTION_LANE_H + span.y,
                    height: span.height,
                  }}
                />
              );
            })}
            {view === 'dope' && layout.rows.map((row) => {
              if (row.kind === 'director') {
                return (
                  <div
                    key={`lane-d:${row.directorId}`}
                    className="border-b border-border/40 bg-surface-2/80"
                    style={{ height: DIRECTOR_HDR_H }}
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
