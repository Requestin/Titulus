// frontend/src/editor/panels/TimelinePanel.tsx
//
// Timeline editor: director tree, dope sheet, curve view, per-director playheads.

import { useRef, useState, useLayoutEffect, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  pointerWithin,
  useDroppable,
  type CollisionDetection,
  type DragCancelEvent,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Play, Pause, Square, Plus, Trash2, Activity, ListTree, GripVertical, ChevronRight, ChevronDown, SkipBack, Folder } from 'lucide-react';
import { ANIMATABLE_PROPS, getEasing, type AnimatableProp, type EasingType } from '@runtime';
import { useEditor, type Target } from '../store';
import {
  collectDirectorTree,
  trackKey,
  targetLabel,
  trackPropLabel,
  directorForTrack,
  type TimelineTrack,
} from '../timelineTracks';
import { Select, NumberInput, Checkbox } from '@/components/ui/form';
import { cn } from '@/lib/cn';

const EASINGS: EasingType[] = ['linear', 'power2.in', 'power2.out', 'power2.inOut', 'bounce.out', 'elastic.out'];
const HEADER_W = 168;
const LANE_H = 26;
const DIRECTOR_HDR_H = 24;
/** Sticky track-name column sits above scrolling keyframe graphics. */
const TRACK_HEADER_Z = 'z-[30]';
const TRACK_HEADER_BG = 'bg-surface';
const DIRECTOR_HEADER_BG = 'bg-surface-2';
const TRACK_HEADER_SHADOW = 'shadow-[2px_0_6px_-2px_oklch(var(--bg)/0.85)]';

/** Prefer pointer hits on droppable director zones, then sortable tracks. */
const timelineCollision: CollisionDetection = (args) => {
  const pointer = pointerWithin(args);
  const directorHit = pointer.find((c) => String(c.id).startsWith('director:'));
  if (directorHit) return [directorHit];
  if (pointer.length > 0) return pointer;
  return closestCenter(args);
};

function KbdBadge({ children, className }: { children: string; className?: string }) {
  return (
    <span className={cn('grid h-5 min-w-[1.25rem] place-items-center rounded border border-border px-1 text-[10px] font-semibold tabular-nums', className)}>
      {children}
    </span>
  );
}

function DirectorIcon() {
  return (
    <span className="relative inline-grid h-3.5 w-3.5 shrink-0 place-items-center">
      <Folder className="h-3.5 w-3.5 text-primary/80" strokeWidth={2} />
      <span className="absolute text-[7px] font-bold leading-none text-primary">D</span>
    </span>
  );
}

export type SelectedKeyframe = {
  target: Target;
  prop: AnimatableProp;
  frame: number;
};

interface Point {
  frame: number;
  value: number;
  easing: EasingType;
}

function isSameKeyframe(a: SelectedKeyframe, target: Target, prop: AnimatableProp, frame: number): boolean {
  return a.target.kind === target.kind && a.target.id === target.id && a.prop === prop && a.frame === frame;
}

type TrackDragIntent =
  | { type: 'before'; trackId: string }
  | { type: 'after'; trackId: string }
  | { type: 'director'; directorId: string };

function activeDragCenter(event: DragMoveEvent | DragOverEvent | DragEndEvent): { x: number; y: number } | null {
  const rect = event.active.rect.current.translated ?? event.active.rect.current.initial;
  if (!rect) return null;
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function computeTrackDragIntent(
  event: DragMoveEvent | DragOverEvent | DragEndEvent,
  trackIds: string[],
): TrackDragIntent | null {
  if (!event.over) return null;
  const overId = String(event.over.id);
  const activeId = String(event.active.id);
  if (activeId === overId) return null;

  if (overId.startsWith('director:')) {
    return { type: 'director', directorId: overId.slice('director:'.length) };
  }

  if (!trackIds.includes(overId)) return null;
  const center = activeDragCenter(event);
  const rect = event.over.rect;
  if (!center || !rect) return { type: 'after', trackId: overId };
  return {
    type: center.y < rect.top + rect.height / 2 ? 'before' : 'after',
    trackId: overId,
  };
}

function applyTrackDrag(
  intent: TrackDragIntent,
  activeId: string,
  allTracks: TimelineTrack[],
  directorTree: Array<{ directorId: string; tracks: TimelineTrack[] }>,
  moveTrackToDirector: (track: TimelineTrack, toDirectorId: string, toIndex?: number) => void,
  reorderTracks: (directorId: string, trackKeys: string[]) => void,
): void {
  const track = allTracks.find((t) => trackKey(t.target, t.prop) === activeId);
  if (!track) return;

  if (intent.type === 'director') {
    moveTrackToDirector(track, intent.directorId);
    return;
  }

  const toGroup = directorTree.find((g) => g.tracks.some((t) => trackKey(t.target, t.prop) === intent.trackId));
  const fromGroup = directorTree.find((g) => g.tracks.some((t) => trackKey(t.target, t.prop) === activeId));
  if (!toGroup || !fromGroup) return;

  let toIndex = toGroup.tracks.findIndex((t) => trackKey(t.target, t.prop) === intent.trackId);
  if (intent.type === 'after') toIndex += 1;

  if (fromGroup.directorId !== toGroup.directorId) {
    moveTrackToDirector(track, toGroup.directorId, toIndex);
    return;
  }

  const keys = fromGroup.tracks.map((t) => trackKey(t.target, t.prop));
  const oldIndex = keys.indexOf(activeId);
  if (oldIndex < 0) return;
  const next = keys.filter((k) => k !== activeId);
  if (oldIndex < toIndex) toIndex -= 1;
  toIndex = Math.max(0, Math.min(toIndex, next.length));
  next.splice(toIndex, 0, activeId);
  reorderTracks(fromGroup.directorId, next);
}

export function TimelinePanel() {
  const template = useEditor((s) => s.template);
  const selection = useEditor((s) => s.selection);
  const select = useEditor((s) => s.select);
  const playheads = useEditor((s) => s.playheads);
  const playing = useEditor((s) => s.playing);
  const activeDirectorId = useEditor((s) => s.activeDirectorId);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const setPlaying = useEditor((s) => s.setPlaying);
  const setActiveDirector = useEditor((s) => s.setActiveDirector);
  const addDirector = useEditor((s) => s.addDirector);
  const updateDirector = useEditor((s) => s.updateDirector);
  const removeDirector = useEditor((s) => s.removeDirector);
  const addTrackAtPlayhead = useEditor((s) => s.addTrackAtPlayhead);
  const removeTrack = useEditor((s) => s.removeTrack);
  const deletePoint = useEditor((s) => s.deletePoint);
  const moveTrackToDirector = useEditor((s) => s.moveTrackToDirector);
  const reorderTracks = useEditor((s) => s.reorderTracks);

  const [view, setView] = useState<'dope' | 'curve'>('dope');
  const [pxPerFrame, setPxPerFrame] = useState(6);
  const [activeTrack, setActiveTrack] = useState<TimelineTrack | null>(null);
  const [selectedKf, setSelectedKf] = useState<SelectedKeyframe | null>(null);
  const setKeyframeValue = useEditor((s) => s.setKeyframeValue);
  const [addOpen, setAddOpen] = useState(false);
  const [addMenuPos, setAddMenuPos] = useState<{ left: number; top: number } | null>(null);
  const [collapsedDirectors, setCollapsedDirectors] = useState<Set<string>>(() => new Set());
  const [dragIntent, setDragIntent] = useState<TrackDragIntent | null>(null);
  const [draggingTrackLabel, setDraggingTrackLabel] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const addTrackBtnRef = useRef<HTMLButtonElement>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  if (!template) return null;

  const dir = template.timeline.directors.find((d) => d.id === activeDirectorId) ?? template.timeline.directors[0];
  const activePlayhead = playheads[dir?.id ?? ''] ?? 0;
  const dur = dir?.durationFrames ?? template.timeline.durationFrames;
  const maxDur = Math.max(...template.timeline.directors.map((d) => d.durationFrames), template.timeline.durationFrames);
  const timelineWidth = Math.max(maxDur * pxPerFrame + 24, 100);

  const directorTree = collectDirectorTree(template);
  const allTracks = directorTree.flatMap((g) => g.tracks);
  const allTrackIds = allTracks.map((t) => trackKey(t.target, t.prop));

  const selectedTarget: Target | null = selection ? { kind: selection.kind, id: selection.id } : null;
  const selectedTrackedProps: AnimatableProp[] = selectedTarget
    ? ANIMATABLE_PROPS.filter((p) => template.timeline.keyframes.some((k) => {
        const bag = (selectedTarget.kind === 'layer' ? k.layers : k.groups)[selectedTarget.id];
        return bag && bag[p] !== undefined;
      }))
    : [];
  const untrackedProps = ANIMATABLE_PROPS.filter((p) => !selectedTrackedProps.includes(p));

  useLayoutEffect(() => {
    if (!addOpen || !addTrackBtnRef.current) return;
    const r = addTrackBtnRef.current.getBoundingClientRect();
    setAddMenuPos({ left: r.left, top: r.top });
  }, [addOpen]);

  const activeTrackResolved = activeTrack && allTracks.some((t) => trackKey(t.target, t.prop) === trackKey(activeTrack.target, activeTrack.prop))
    ? activeTrack
    : (selectedTarget
      ? allTracks.find((t) => t.target.kind === selectedTarget.kind && t.target.id === selectedTarget.id) ?? allTracks[0] ?? null
      : allTracks[0] ?? null);

  function frameToX(f: number) { return f * pxPerFrame; }

  function xToFrame(x: number) { return Math.max(0, Math.round(x / pxPerFrame)); }

  /** Frame from pointer on a full-width lane/ruler element (content coordinates). */
  function frameFromContentX(clientX: number, el: Element, maxFrame: number): number {
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left;
    return Math.min(maxFrame, Math.max(0, xToFrame(x)));
  }

  function scrubDirector(directorId: string, maxFrame: number, e: ReactPointerEvent, el: Element) {
    setPlaying(false);
    setActiveDirector(directorId);
    setPlayhead(directorId, frameFromContentX(e.clientX, el, maxFrame));
  }

  function selectTrack(track: TimelineTrack) {
    if (!template) return;
    select(track.target);
    setActiveTrack(track);
    const did = directorForTrack(template, track);
    setActiveDirector(did);
  }

  function toggleDirectorCollapse(directorId: string) {
    setCollapsedDirectors((prev) => {
      const next = new Set(prev);
      if (next.has(directorId)) next.delete(directorId);
      else next.add(directorId);
      return next;
    });
  }

  function jumpToBeginning() {
    if (!template) return;
    setPlaying(false);
    for (const d of template.timeline.directors) setPlayhead(d.id, 0);
  }

  function stopPlayback() {
    setPlaying(false);
  }

  function handleAddKeyframe() {
    if (!template || !activeTrackResolved) return;
    const did = directorForTrack(template, activeTrackResolved);
    const ph = playheads[did] ?? 0;
    const pts = keyframePointsFor(activeTrackResolved.target, activeTrackResolved.prop);
    if (pts.some((p) => p.frame === ph)) return;
    const v = sampleValue(pts, ph);
    setKeyframeValue(activeTrackResolved.target, ph, activeTrackResolved.prop, v, did);
    setSelectedKf({ target: activeTrackResolved.target, prop: activeTrackResolved.prop, frame: ph });
  }

  function handleRemoveTrack(track: TimelineTrack) {
    removeTrack(track.target, track.prop);
    if (activeTrack && trackKey(activeTrack.target, activeTrack.prop) === trackKey(track.target, track.prop)) {
      setActiveTrack(null);
    }
    if (selectedKf && selectedKf.target.kind === track.target.kind && selectedKf.target.id === track.target.id && selectedKf.prop === track.prop) {
      setSelectedKf(null);
    }
  }

  function handleDeleteKeyframe() {
    if (!selectedKf) return;
    deletePoint(selectedKf.target, selectedKf.prop, selectedKf.frame);
    setSelectedKf(null);
  }

  function onDragStart(event: DragStartEvent) {
    if (!template) return;
    const activeId = String(event.active.id);
    const track = allTracks.find((t) => trackKey(t.target, t.prop) === activeId);
    if (track) {
      setDraggingTrackLabel(`${targetLabel(template, track.target)} · ${trackPropLabel(track.prop)}`);
    }
  }

  function onDragMove(event: DragMoveEvent) {
    setDragIntent(computeTrackDragIntent(event, allTrackIds));
  }

  function onDragOver(event: DragOverEvent) {
    setDragIntent(computeTrackDragIntent(event, allTrackIds));
  }

  function clearDragState() {
    setDragIntent(null);
    setDraggingTrackLabel(null);
  }

  function onDragCancel(_event: DragCancelEvent) {
    clearDragState();
  }

  function onDragEnd(event: DragEndEvent) {
    const intent = computeTrackDragIntent(event, allTrackIds) ?? dragIntent;
    clearDragState();
    if (!intent) return;
    applyTrackDrag(intent, String(event.active.id), allTracks, directorTree, moveTrackToDirector, reorderTracks);
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      {/* Transport */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
        <button
          onClick={jumpToBeginning}
          className="grid h-7 w-7 place-items-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink"
          title="Jump to beginning"
        >
          <SkipBack className="h-4 w-4" />
        </button>
        <button
          onClick={() => setPlaying(!playing)}
          className="grid h-7 w-7 place-items-center rounded-md text-ink hover:bg-surface-2"
          title={playing ? 'Pause' : 'Play'}
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
        <button
          onClick={stopPlayback}
          className="grid h-7 w-7 place-items-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink"
          title="Stop"
        >
          <Square className="h-3.5 w-3.5" />
        </button>
        <span className="w-28 text-center text-[12px] tabular-nums text-ink-muted">
          {Math.round(activePlayhead)} / {dur}
        </span>

        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setView('dope')}
            className={cn('grid h-7 w-7 place-items-center rounded-md', view === 'dope' ? 'bg-primary/20 text-ink' : 'text-ink-muted hover:bg-surface-2')}
            title="Dope sheet"
          >
            <ListTree className="h-4 w-4" />
          </button>
          <button
            onClick={() => setView('curve')}
            className={cn('grid h-7 w-7 place-items-center rounded-md', view === 'curve' ? 'bg-primary/20 text-ink' : 'text-ink-muted hover:bg-surface-2')}
            title="Curve editor"
          >
            <Activity className="h-4 w-4" />
          </button>
          <button onClick={() => setPxPerFrame((v) => Math.max(2, v - 2))} className="px-1.5 text-ink-muted hover:text-ink" title="Zoom out">-</button>
          <button onClick={() => setPxPerFrame((v) => Math.min(24, v + 2))} className="px-1.5 text-ink-muted hover:text-ink" title="Zoom in">+</button>
        </div>
      </div>

      {/* Active director props */}
      {dir && (
        <div className="flex h-8 shrink-0 items-center gap-3 border-b border-border px-2 text-[12px] text-ink-muted">
          <span className="font-medium text-ink">{dir.name}</span>
          <label className="flex items-center gap-1.5">Dur
            <NumberInput value={dir.durationFrames} onChange={(v) => updateDirector(dir.id, { durationFrames: Math.max(1, Math.round(v)) })} className="h-6 w-16" />
          </label>
          <label className="flex items-center gap-1.5">Offset
            <NumberInput value={dir.offsetFrames} onChange={(v) => updateDirector(dir.id, { offsetFrames: Math.max(0, Math.round(v)) })} className="h-6 w-16" />
          </label>
          <Checkbox label="loop" checked={dir.loop} onChange={(v) => updateDirector(dir.id, { loop: v })} />
          <Checkbox label="swing" checked={dir.swing} onChange={(v) => updateDirector(dir.id, { swing: v })} />
          <Checkbox label="autostart" checked={dir.autostart} onChange={(v) => updateDirector(dir.id, { autostart: v })} />
        </div>
      )}

      {/* Keyframe / director actions */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-2">
        <button
          type="button"
          onClick={addDirector}
          title="Add director"
          className="rounded-md px-1.5 py-1 text-ink-muted hover:bg-surface-2 hover:text-ink"
        >
          <KbdBadge>+D</KbdBadge>
        </button>
        <button
          type="button"
          disabled={!activeTrackResolved}
          onClick={handleAddKeyframe}
          title="Add keyframe"
          className={cn(
            'rounded-md px-1.5 py-1',
            !activeTrackResolved
              ? 'cursor-not-allowed opacity-40'
              : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
          )}
        >
          <KbdBadge>+K</KbdBadge>
        </button>
        <button
          type="button"
          disabled={selectedKf === null}
          onClick={handleDeleteKeyframe}
          title="Delete keyframe"
          className={cn(
            'rounded-md px-1.5 py-1',
            selectedKf === null
              ? 'cursor-not-allowed opacity-40'
              : 'text-ink-muted hover:bg-surface-2 hover:text-danger',
          )}
        >
          <KbdBadge className={selectedKf !== null ? 'hover:border-danger hover:text-danger' : undefined}>-K</KbdBadge>
        </button>
      </div>

      {/* Unified scroll body */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <DndContext
          sensors={sensors}
          collisionDetection={timelineCollision}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={onDragCancel}
        >
          <SortableContext items={allTrackIds} strategy={verticalListSortingStrategy}>
          <div style={{ width: HEADER_W + timelineWidth }}>
            {view === 'dope' && (
              <>
                {directorTree.map(({ directorId, tracks }) => {
                  const d = template.timeline.directors.find((x) => x.id === directorId);
                  if (!d) return null;
                  const sectionDur = d.durationFrames;
                  const sectionPlayhead = playheads[directorId] ?? 0;
                  const isActiveDir = activeDirectorId === directorId;
                  const isCollapsed = collapsedDirectors.has(directorId);

                  return (
                    <DirectorSection
                      key={directorId}
                      directorId={directorId}
                      dropActive={dragIntent?.type === 'director' && dragIntent.directorId === directorId}
                    >
                      <div className="flex">
                        <DirectorHeader
                          name={d.name}
                          selected={isActiveDir}
                          collapsed={isCollapsed}
                          onToggleCollapse={() => toggleDirectorCollapse(directorId)}
                          onSelect={() => setActiveDirector(directorId)}
                          onRemove={() => removeDirector(directorId)}
                        />
                        <div className="relative z-0 shrink-0" style={{ width: timelineWidth }}>
                          <DirectorRuler
                            dur={sectionDur}
                            pxPerFrame={pxPerFrame}
                            onScrub={(e, el) => scrubDirector(directorId, sectionDur, e, el)}
                          />
                          <div
                            className="pointer-events-none absolute top-0 z-sticky w-px bg-live"
                            style={{ left: frameToX(sectionPlayhead), height: DIRECTOR_HDR_H }}
                          >
                            <div className="pointer-events-auto absolute -left-1 top-0 h-2 w-2 rounded-sm bg-live" />
                          </div>
                        </div>
                      </div>

                      {!isCollapsed && (
                        <>
                        {tracks.map((track) => (
                          <SortableTrackRow
                            key={trackKey(track.target, track.prop)}
                            track={track}
                            trackId={trackKey(track.target, track.prop)}
                            label={`${targetLabel(template, track.target)} · ${trackPropLabel(track.prop)}`}
                            isActive={!!activeTrackResolved && trackKey(activeTrackResolved.target, activeTrackResolved.prop) === trackKey(track.target, track.prop)}
                            dropBefore={dragIntent?.type === 'before' && dragIntent.trackId === trackKey(track.target, track.prop)}
                            dropAfter={dragIntent?.type === 'after' && dragIntent.trackId === trackKey(track.target, track.prop)}
                            onSelect={() => selectTrack(track)}
                            onRemove={() => handleRemoveTrack(track)}
                            timelineWidth={timelineWidth}
                            lane={
                              <DopeLane
                                target={track.target}
                                prop={track.prop}
                                directorId={directorId}
                                pxPerFrame={pxPerFrame}
                                dur={sectionDur}
                                frameFromEvent={(e, el) => frameFromContentX(e.clientX, el, sectionDur)}
                                selectedKf={selectedKf}
                                onSelectKeyframe={setSelectedKf}
                                onClearSelection={() => setSelectedKf(null)}
                              />
                            }
                          />
                        ))}

                        {tracks.length === 0 && (
                          <DirectorDropLane timelineWidth={timelineWidth} />
                        )}
                        </>
                      )}
                    </DirectorSection>
                  );
                })}

                {directorTree.length === 0 && (
                  <p className="p-3 text-[12px] text-ink-faint">Add a director or track to start.</p>
                )}
              </>
            )}

            {view === 'curve' && activeTrackResolved && (
              <div className="flex">
                <div
                  className={cn(
                    'sticky left-0 shrink-0 border-r border-border px-2 py-1 text-[12px] text-ink',
                    TRACK_HEADER_Z,
                    TRACK_HEADER_BG,
                    TRACK_HEADER_SHADOW,
                  )}
                  style={{ width: HEADER_W }}
                >
                  {targetLabel(template, activeTrackResolved.target)} · {trackPropLabel(activeTrackResolved.prop)}
                </div>
                <div style={{ width: timelineWidth }} className="relative z-0">
                  <CurveView
                    target={activeTrackResolved.target}
                    prop={activeTrackResolved.prop}
                    pxPerFrame={pxPerFrame}
                    dur={dur}
                    frameFromEvent={(e, el) => frameFromContentX(e.clientX, el, dur)}
                    selectedKf={selectedKf}
                    onSelectKeyframe={setSelectedKf}
                    onClearSelection={() => setSelectedKf(null)}
                  />
                </div>
              </div>
            )}

            {view === 'curve' && !activeTrackResolved && (
              <div className="p-3 text-[12px] text-ink-faint">Add a track to edit its curve.</div>
            )}

            {/* +Track inside scroll area */}
            {selectedTarget && view === 'dope' && (
              <div className="flex border-t border-border">
                <div
                  className={cn(
                    'sticky left-0 relative shrink-0 border-r border-border p-1.5',
                    TRACK_HEADER_Z,
                    TRACK_HEADER_BG,
                    TRACK_HEADER_SHADOW,
                  )}
                  style={{ width: HEADER_W }}
                >
                  <button
                    ref={addTrackBtnRef}
                    onClick={() => setAddOpen((v) => !v)}
                    disabled={untrackedProps.length === 0}
                    className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border py-1 text-[12px] text-ink-muted hover:text-ink disabled:opacity-40"
                  >
                    <Plus className="h-3.5 w-3.5" /> Track
                  </button>
                </div>
                <div style={{ width: timelineWidth, height: 40 }} />
              </div>
            )}
          </div>
          </SortableContext>
          <DragOverlay dropAnimation={null}>
            {draggingTrackLabel ? (
              <TrackDragOverlay label={draggingTrackLabel} />
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      {addOpen && addMenuPos && createPortal(
        <>
          <div className="fixed inset-0 z-[200]" onClick={() => setAddOpen(false)} aria-hidden />
          <div
            className="fixed z-[201] grid max-h-48 w-28 grid-cols-2 gap-0.5 overflow-auto rounded-md border border-border bg-surface p-1 shadow-2xl"
            style={{ left: addMenuPos.left, top: addMenuPos.top, transform: 'translateY(calc(-100% - 6px))' }}
          >
            {untrackedProps.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => {
                  if (!selectedTarget) return;
                  const track = { target: selectedTarget, prop: p };
                  addTrackAtPlayhead(selectedTarget, p);
                  setActiveTrack(track);
                  setAddOpen(false);
                }}
                className="rounded bg-surface px-1 py-1 text-left text-[11px] text-ink hover:bg-surface-2"
              >
                {trackPropLabel(p)}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

function TrackDragOverlay({ label }: { label: string }) {
  return (
    <div
      style={{ width: HEADER_W, height: LANE_H }}
      className="flex items-center gap-0.5 rounded-md border border-primary/50 bg-surface pl-1 pr-1 shadow-lg ring-2 ring-primary/30"
    >
      <GripVertical className="h-3.5 w-3.5 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink tabular-nums">{label}</span>
    </div>
  );
}

function TrackDropLine({ position }: { position: 'before' | 'after' }) {
  return (
    <div
      className={cn(
        'pointer-events-none absolute left-1 right-1 z-20 h-0.5 rounded-full bg-primary shadow-[0_0_0_1px_oklch(var(--primary)/0.2)]',
        position === 'before' ? 'top-0' : 'bottom-0',
      )}
      aria-hidden
    />
  );
}

function DirectorSection({
  directorId, children, dropActive,
}: {
  directorId: string;
  children: ReactNode;
  dropActive?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `director:${directorId}` });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'border-b border-border/30',
        (isOver || dropActive) && 'bg-primary/10 ring-1 ring-inset ring-primary/35',
      )}
    >
      {children}
    </div>
  );
}

function DirectorDropLane({ timelineWidth }: { timelineWidth: number }) {
  return (
    <div className="flex">
      <div
        className={cn('sticky left-0 shrink-0 border-r border-border/40 px-2 py-1 text-[11px] text-ink-faint', TRACK_HEADER_Z, TRACK_HEADER_BG, TRACK_HEADER_SHADOW)}
        style={{ width: HEADER_W, height: LANE_H }}
      >
        Drop track here
      </div>
      <div style={{ width: timelineWidth, height: LANE_H }} className="border-b border-border/20 bg-surface/30" />
    </div>
  );
}

function DirectorHeader({
  name, selected, collapsed, onToggleCollapse, onSelect, onRemove,
}: {
  name: string;
  selected: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSelect: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      style={{ width: HEADER_W, height: DIRECTOR_HDR_H }}
      className={cn(
        'group sticky left-0 flex shrink-0 items-center gap-0.5 border-r border-border/60 pl-1 pr-2 text-[11px] font-semibold',
        TRACK_HEADER_Z,
        DIRECTOR_HEADER_BG,
        TRACK_HEADER_SHADOW,
        selected ? 'text-ink ring-1 ring-inset ring-primary/25' : 'text-ink-muted',
      )}
    >
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}
        className="grid h-5 w-5 shrink-0 place-items-center rounded text-ink-faint hover:bg-surface hover:text-ink"
        aria-label={collapsed ? 'Expand director' : 'Collapse director'}
      >
        {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-1 text-left">
        <DirectorIcon />
        <span className="truncate">{name}</span>
      </button>
      <button
        type="button"
        title="Remove director"
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        className="grid h-5 w-5 shrink-0 place-items-center rounded text-ink-faint opacity-0 hover:bg-surface hover:text-danger group-hover:opacity-100"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}

function DirectorRuler({
  dur, pxPerFrame, onScrub,
}: {
  dur: number;
  pxPerFrame: number;
  onScrub: (e: ReactPointerEvent, el: Element) => void;
}) {
  const step = pxPerFrame < 4 ? 50 : pxPerFrame < 10 ? 25 : 10;
  const ticks: number[] = [];
  for (let f = 0; f <= dur; f += step) ticks.push(f);
  const w = Math.max(dur * pxPerFrame + 24, 100);

  return (
    <div
      className="relative cursor-pointer select-none border-b border-border/40 bg-surface/80"
      style={{ height: DIRECTOR_HDR_H, width: w }}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); onScrub(e, e.currentTarget); }}
      onPointerMove={(e) => { if (e.buttons === 1) onScrub(e, e.currentTarget); }}
    >
      {ticks.map((f) => (
        <div
          key={f}
          className="absolute top-0 h-full border-l border-border/50 pl-1 text-[10px] tabular-nums text-ink-faint"
          style={{ left: f * pxPerFrame }}
        >
          {f}
        </div>
      ))}
    </div>
  );
}

function SortableTrackRow({
  trackId, label, isActive, dropBefore, dropAfter, onSelect, onRemove, timelineWidth, lane,
}: {
  track: TimelineTrack;
  trackId: string;
  label: string;
  isActive: boolean;
  dropBefore?: boolean;
  dropAfter?: boolean;
  onSelect: () => void;
  onRemove: () => void;
  timelineWidth: number;
  lane: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: trackId });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('relative flex', isDragging && 'z-0')}
    >
      {dropBefore && <TrackDropLine position="before" />}
      {dropAfter && <TrackDropLine position="after" />}
      <div
        style={{ width: HEADER_W, height: LANE_H }}
        className={cn(
          'sticky left-0 flex shrink-0 items-center gap-0.5 border-r border-border/40 pl-1 pr-1',
          TRACK_HEADER_Z,
          TRACK_HEADER_BG,
          TRACK_HEADER_SHADOW,
          isActive ? 'text-ink ring-1 ring-inset ring-primary/25' : 'text-ink-muted hover:bg-surface-2',
          isDragging && 'opacity-30',
        )}
      >
        <button
          type="button"
          className="grid h-5 w-5 shrink-0 cursor-grab place-items-center text-ink-faint hover:text-ink"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={onSelect} className="min-w-0 flex-1 truncate text-left text-[12px] tabular-nums">
          {label}
        </button>
        <button
          type="button"
          title="Remove track"
          onClick={onRemove}
          className="grid h-5 w-5 shrink-0 place-items-center rounded text-ink-faint hover:text-danger"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
      <div style={{ width: timelineWidth }} className={cn('relative z-0', isDragging && 'opacity-30')}>{lane}</div>
    </div>
  );
}

function keyframePointsFor(target: Target, prop: AnimatableProp): Point[] {
  const t = useEditor.getState().template;
  if (!t) return [];
  const out: Point[] = [];
  for (const k of t.timeline.keyframes) {
    const bag = (target.kind === 'layer' ? k.layers : k.groups)[target.id];
    if (bag && bag[prop] !== undefined) out.push({ frame: k.frame, value: bag[prop] as number, easing: k.easing });
  }
  return out.sort((a, b) => a.frame - b.frame);
}

function DopeLane({
  target, prop, pxPerFrame, dur, frameFromEvent, selectedKf, onSelectKeyframe,
}: {
  target: Target;
  prop: AnimatableProp;
  directorId: string;
  pxPerFrame: number;
  dur: number;
  frameFromEvent: (e: ReactPointerEvent, laneEl: Element) => number;
  selectedKf: SelectedKeyframe | null;
  onSelectKeyframe: (kf: SelectedKeyframe) => void;
  onClearSelection: () => void;
}) {
  const movePoint = useEditor((s) => s.movePoint);
  const moveKeyframeSegment = useEditor((s) => s.moveKeyframeSegment);
  const [drag, setDrag] = useState<{ kind: 'kf'; from: number; cur: number } | { kind: 'seg'; edgeIndex: number; fromX: number; curDelta: number } | null>(null);

  const points = keyframePointsFor(target, prop);
  const laneW = Math.max(dur * pxPerFrame + 24, 100);

  function frameAt(p: Point, idx: number): number {
    if (!drag) return p.frame;
    if (drag.kind === 'kf' && drag.from === p.frame) return drag.cur;
    if (drag.kind === 'seg') {
      const component = segmentComponentIndices(points, drag.edgeIndex);
      if (component.has(idx)) {
        return Math.max(0, Math.min(dur, p.frame + drag.curDelta));
      }
    }
    return p.frame;
  }

  return (
    <div
      className="relative z-0 overflow-hidden border-b border-border/40"
      style={{ height: LANE_H, width: laneW }}
    >
      {points.slice(0, -1).map((a, i) => {
        const b = points[i + 1]!;
        if (a.value === b.value) return null;
        const x1 = frameAt(a, i) * pxPerFrame;
        const x2 = frameAt(b, i + 1) * pxPerFrame;
        const left = Math.min(x1, x2);
        return (
          <div
            key={`${a.frame}-${b.frame}`}
            data-seg="1"
            className="absolute top-1/2 z-[1] h-1 -translate-y-1/2 cursor-ew-resize bg-primary/55"
            style={{ left, width: Math.max(2, Math.abs(x2 - x1)) }}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              setDrag({ kind: 'seg', edgeIndex: i, fromX: e.clientX, curDelta: 0 });
            }}
            onPointerMove={(e) => {
              if (!drag || drag.kind !== 'seg') return;
              const deltaPx = e.clientX - drag.fromX;
              setDrag({ ...drag, curDelta: Math.round(deltaPx / pxPerFrame) });
            }}
            onPointerUp={() => {
              if (drag?.kind === 'seg' && drag.curDelta !== 0) {
                moveKeyframeSegment(target, prop, drag.edgeIndex, drag.curDelta);
              }
              setDrag(null);
            }}
          />
        );
      })}
      {points.map((p, idx) => {
        const left = frameAt(p, idx) * pxPerFrame;
        const isSelected = selectedKf !== null && isSameKeyframe(selectedKf, target, prop, p.frame);
        return (
          <div
            key={p.frame}
            data-kf="1"
            title={`${trackPropLabel(prop)} @ ${p.frame} = ${p.value}`}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              onSelectKeyframe({ target, prop, frame: p.frame });
              setDrag({ kind: 'kf', from: p.frame, cur: p.frame });
            }}
            onPointerMove={(e) => {
              if (!drag || drag.kind !== 'kf') return;
              setDrag({ kind: 'kf', from: drag.from, cur: frameFromEvent(e, e.currentTarget.parentElement as HTMLElement) });
            }}
            onPointerUp={() => {
              if (drag?.kind === 'kf' && drag.cur !== drag.from) {
                movePoint(target, prop, drag.from, drag.cur);
                if (selectedKf && isSameKeyframe(selectedKf, target, prop, drag.from)) {
                  onSelectKeyframe({ target, prop, frame: drag.cur });
                }
              }
              setDrag(null);
            }}
            className={cn(
              'absolute top-1/2 z-[2] h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-grab rounded-[2px] border',
              isSelected ? 'border-live bg-live/85' : 'border-primary bg-primary/70',
            )}
            style={{ left }}
          />
        );
      })}
    </div>
  );
}

function segmentComponentIndices(points: Point[], edgeIndex: number): Set<number> {
  const component = new Set<number>();
  const stack = [edgeIndex, edgeIndex + 1];
  while (stack.length) {
    const i = stack.pop()!;
    if (component.has(i)) continue;
    component.add(i);
    if (i > 0 && points[i - 1]!.value !== points[i]!.value) stack.push(i - 1);
    if (i < points.length - 1 && points[i]!.value !== points[i + 1]!.value) stack.push(i + 1);
  }
  return component;
}

function CurveView({
  target, prop, pxPerFrame, dur, frameFromEvent, selectedKf, onSelectKeyframe, onClearSelection,
}: {
  target: Target;
  prop: AnimatableProp;
  pxPerFrame: number;
  dur: number;
  frameFromEvent: (e: ReactPointerEvent, laneEl: Element) => number;
  selectedKf: SelectedKeyframe | null;
  onSelectKeyframe: (kf: SelectedKeyframe) => void;
  onClearSelection: () => void;
}) {
  const setKeyframeValue = useEditor((s) => s.setKeyframeValue);
  const movePoint = useEditor((s) => s.movePoint);
  const deletePoint = useEditor((s) => s.deletePoint);
  const setKeyframeEasing = useEditor((s) => s.setKeyframeEasing);
  const [drag, setDrag] = useState<{ from: number; curFrame: number; curValue: number } | null>(null);

  const points = keyframePointsFor(target, prop);
  const selFrame = selectedKf
    && selectedKf.target.kind === target.kind
    && selectedKf.target.id === target.id
    && selectedKf.prop === prop
    ? selectedKf.frame
    : null;

  const W = Math.max(dur * pxPerFrame + 24, 100);
  const H = 150;
  const values = points.map((p) => p.value);
  let vMin = Math.min(...values, 0);
  let vMax = Math.max(...values, 1);
  if (vMin === vMax) { vMin -= 1; vMax += 1; }
  const pad = (vMax - vMin) * 0.15 || 1;
  vMin -= pad; vMax += pad;
  const yOf = (v: number) => H - ((v - vMin) / (vMax - vMin)) * H;
  const vOf = (y: number) => vMin + (1 - y / H) * (vMax - vMin);

  const path: string[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    if (i === 0) { path.push(`M ${a.frame * pxPerFrame} ${yOf(a.value)}`); continue; }
    const prev = points[i - 1]!;
    const ease = getEasing(prev.easing);
    const steps = 16;
    for (let s = 1; s <= steps; s++) {
      const tt = s / steps;
      const f = prev.frame + (a.frame - prev.frame) * tt;
      const val = prev.value + (a.value - prev.value) * ease(tt);
      path.push(`L ${f * pxPerFrame} ${yOf(val)}`);
    }
  }

  function bgClick(e: ReactPointerEvent<SVGSVGElement>) {
    if ((e.target as Element).tagName === 'circle') return;
    onClearSelection();
    const frame = frameFromEvent(e, e.currentTarget);
    if (points.some((p) => p.frame === frame)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const value = vOf(e.clientY - rect.top);
    setKeyframeValue(target, frame, prop, Math.round(value * 100) / 100);
  }

  return (
    <div>
      <svg width={W} height={H} className="block touch-none" onPointerDown={bgClick}>
        <path d={path.join(' ')} fill="none" stroke="oklch(var(--primary))" strokeWidth={1.5} />
        {points.map((p) => {
          const cx = (drag && drag.from === p.frame ? drag.curFrame : p.frame) * pxPerFrame;
          const cy = yOf(drag && drag.from === p.frame ? drag.curValue : p.value);
          return (
            <circle
              key={p.frame}
              cx={cx}
              cy={cy}
              r={5}
              className={cn('cursor-grab', selFrame === p.frame ? 'fill-live' : 'fill-primary')}
              stroke="oklch(var(--ink))"
              strokeWidth={selFrame === p.frame ? 1.5 : 0}
              onPointerDown={(e) => {
                e.stopPropagation();
                (e.currentTarget as SVGCircleElement).setPointerCapture(e.pointerId);
                onSelectKeyframe({ target, prop, frame: p.frame });
                setDrag({ from: p.frame, curFrame: p.frame, curValue: p.value });
              }}
              onPointerMove={(e) => {
                if (!drag) return;
                const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                const f = frameFromEvent(e, e.currentTarget.ownerSVGElement as SVGSVGElement);
                const v = Math.round(vOf(e.clientY - rect.top) * 100) / 100;
                setDrag({ from: drag.from, curFrame: f, curValue: v });
              }}
              onPointerUp={() => {
                if (drag) {
                  if (drag.curValue !== p.value) setKeyframeValue(target, drag.from, prop, drag.curValue);
                  if (drag.curFrame !== drag.from) {
                    movePoint(target, prop, drag.from, drag.curFrame);
                    if (selectedKf && isSameKeyframe(selectedKf, target, prop, drag.from)) {
                      onSelectKeyframe({ target, prop, frame: drag.curFrame });
                    }
                  }
                }
                setDrag(null);
              }}
              onDoubleClick={() => { deletePoint(target, prop, p.frame); onClearSelection(); }}
            />
          );
        })}
      </svg>
      {selFrame !== null && points.some((p) => p.frame === selFrame) && (
        <div className="flex items-center gap-2 px-2 py-1.5 text-[12px] text-ink-muted">
          <span>Keyframe @ {selFrame}</span>
          <span>easing</span>
          <Select
            value={points.find((p) => p.frame === selFrame)?.easing}
            onChange={(e) => setKeyframeEasing(selFrame, e.target.value as EasingType)}
            className="h-7 w-32"
          >
            {EASINGS.map((es) => <option key={es} value={es}>{es}</option>)}
          </Select>
        </div>
      )}
    </div>
  );
}

function sampleValue(points: Point[], frame: number): number {
  if (points.length === 0) return 0;
  if (frame <= points[0]!.frame) return points[0]!.value;
  if (frame >= points[points.length - 1]!.frame) return points[points.length - 1]!.value;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!; const b = points[i + 1]!;
    if (frame >= a.frame && frame <= b.frame) {
      const tt = (frame - a.frame) / (b.frame - a.frame || 1);
      return Math.round((a.value + (b.value - a.value) * getEasing(a.easing)(tt)) * 100) / 100;
    }
  }
  return points[0]!.value;
}
