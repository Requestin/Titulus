import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { DndContext, DragOverlay, PointerSensor, closestCenter, pointerWithin, useDroppable, useSensor, useSensors, type CollisionDetection, type DragCancelEvent, type DragEndEvent, type DragMoveEvent, type DragOverEvent, type DragStartEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Activity, ChevronDown, ChevronRight, ChevronsRight, Folder, GripVertical, Infinity as InfinityIcon, ListTree, Pause, Play, Plus, SkipBack, Square, Trash2 } from 'lucide-react';
import { ANIMATABLE_PROPS, effectiveActionFrame, getEasing, isUpdateDirectorName, type AnimatableProp, type EasingType } from '@runtime';
import { useEditor, type Target } from '../store';
import { collectDirectorObjectTree, directorForTrack, objectTrackKey, parseObjectTrackKey, sameTarget, targetKeyframeSpan, targetLabel, trackKey, trackPropLabel, type DirectorObjectTree, type TimelineTrack } from '../timelineTracks';
import { getVideoClipWindow, moveVideoClip } from '../videoTimeline';
import { Checkbox, NumberInput, Select } from '@/components/ui/form';
import { cn } from '@/lib/cn';

const EASINGS: EasingType[] = ['linear', 'power2.in', 'power2.out', 'power2.inOut', 'bounce.out', 'elastic.out'];
const HEADER_W = 168;
const LANE_H = 26;
const DIRECTOR_HDR_H = 24;
const ACTION_LANE_H = 22;
const STICKY = 'z-[30]';
const HEADER_BG = 'bg-surface';
const DIRECTOR_BG = 'bg-surface-2';
const HEADER_SHADOW = 'shadow-[2px_0_6px_-2px_oklch(var(--bg)/0.85)]';

export type SelectedKeyframe = { target: Target; prop: AnimatableProp; frame: number };
type Point = { frame: number; value: number; easing: EasingType };
type TrackDragIntent = { type: 'before' | 'after'; trackId: string } | { type: 'director'; directorId: string };
type Marquee = { startX: number; startY: number; endX: number; endY: number };

function KbdBadge({ children, className }: { children: string; className?: string }) {
  return <span className={cn('grid h-5 min-w-[1.25rem] place-items-center rounded border border-border px-1 text-[10px] font-semibold tabular-nums', className)}>{children}</span>;
}

function isSameKeyframe(a: SelectedKeyframe, target: Target, prop: AnimatableProp, frame: number): boolean {
  return sameTarget(a.target, target) && a.prop === prop && a.frame === frame;
}

function isSelectedKeyframe(selected: SelectedKeyframe[], target: Target, prop: AnimatableProp, frame: number): boolean {
  return selected.some((item) => isSameKeyframe(item, target, prop, frame));
}

function toggleKeyframe(selected: SelectedKeyframe[], item: SelectedKeyframe): SelectedKeyframe[] {
  return isSelectedKeyframe(selected, item.target, item.prop, item.frame)
    ? selected.filter((value) => !isSameKeyframe(value, item.target, item.prop, item.frame))
    : [...selected, item];
}

const timelineCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const rows = hits.filter((item) => !String(item.id).startsWith('director:'));
  if (rows.length) return rows;
  const directors = hits.filter((item) => String(item.id).startsWith('director:'));
  if (directors.length) return directors;
  return closestCenter(args);
};

function activeDragCenter(event: DragMoveEvent | DragOverEvent | DragEndEvent): { y: number } | null {
  const rect = event.active.rect.current.translated ?? event.active.rect.current.initial;
  return rect ? { y: rect.top + rect.height / 2 } : null;
}

function computeTrackDragIntent(event: DragMoveEvent | DragOverEvent | DragEndEvent, sortableIds: string[]): TrackDragIntent | null {
  if (!event.over) return null;
  const overId = String(event.over.id);
  if (String(event.active.id) === overId) return null;
  if (overId.startsWith('director:')) return { type: 'director', directorId: overId.slice(9) };
  if (!sortableIds.includes(overId)) return null;
  const center = activeDragCenter(event);
  return { type: center && center.y < event.over.rect.top + event.over.rect.height / 2 ? 'before' : 'after', trackId: overId };
}

function treeTracks(tree: DirectorObjectTree[]): TimelineTrack[] {
  return tree.flatMap((director) => director.objects.flatMap((object) => object.tracks));
}

function objectDirector(tree: DirectorObjectTree[], target: Target): DirectorObjectTree | undefined {
  return tree.find((director) => director.objects.some((object) => sameTarget(object.target, target)));
}

function firstTrackKeyForObject(tree: DirectorObjectTree[], target: Target): string | null {
  const object = tree.flatMap((director) => director.objects).find((item) => sameTarget(item.target, target));
  return object?.tracks[0] ? trackKey(object.tracks[0].target, object.tracks[0].prop) : null;
}

function applyTrackDrag(
  intent: TrackDragIntent,
  activeId: string,
  tree: DirectorObjectTree[],
  moveTrackToDirector: (track: TimelineTrack, directorId: string, index?: number) => void,
  moveObjectToDirector: (target: Target, directorId: string, beforeTrackKey?: string | null) => void,
  reorderTracks: (directorId: string, keys: string[]) => void,
) {
  const objectTarget = parseObjectTrackKey(activeId);
  const destinationTarget = intent.type === 'director' ? null : parseObjectTrackKey(intent.trackId);
  const destinationTrack = intent.type === 'director' ? null : treeTracks(tree).find((track) => trackKey(track.target, track.prop) === intent.trackId);
  const destinationDirector = intent.type === 'director'
    ? intent.directorId
    : destinationTarget
      ? objectDirector(tree, destinationTarget)?.directorId
      : destinationTrack
        ? objectDirector(tree, destinationTrack.target)?.directorId
        : undefined;
  if (!destinationDirector) return;

  const beforeKey = destinationTarget
    ? firstTrackKeyForObject(tree, destinationTarget)
    : destinationTrack
      ? trackKey(destinationTrack.target, destinationTrack.prop)
      : null;

  if (objectTarget) {
    const source = objectDirector(tree, objectTarget);
    if (!source) return;
    if (source.directorId !== destinationDirector) {
      moveObjectToDirector(objectTarget, destinationDirector, beforeKey);
      return;
    }
    const keys = source.objects.flatMap((object) => object.tracks.map((track) => trackKey(track.target, track.prop)));
    const moving = source.objects.find((object) => sameTarget(object.target, objectTarget));
    if (!moving) return;
    const movingKeys = moving.tracks.map((track) => trackKey(track.target, track.prop));
    const remainder = keys.filter((key) => !movingKeys.includes(key));
    let index = beforeKey ? remainder.indexOf(beforeKey) : remainder.length;
    if (intent.type === 'after' && beforeKey) {
      const targetKeys = destinationTarget
        ? source.objects.find((object) => sameTarget(object.target, destinationTarget))?.tracks.map((track) => trackKey(track.target, track.prop)) ?? []
        : [beforeKey];
      index = Math.max(...targetKeys.map((key) => remainder.indexOf(key))) + 1;
    }
    remainder.splice(Math.max(0, index), 0, ...movingKeys);
    reorderTracks(source.directorId, remainder);
    return;
  }

  const track = treeTracks(tree).find((item) => trackKey(item.target, item.prop) === activeId);
  if (!track) return;
  const source = objectDirector(tree, track.target);
  if (!source) return;
  if (source.directorId !== destinationDirector) {
    const targetKeys = treeTracks(tree).filter((item) => objectDirector(tree, item.target)?.directorId === destinationDirector).map((item) => trackKey(item.target, item.prop));
    const index = beforeKey ? targetKeys.indexOf(beforeKey) + (intent.type === 'after' ? 1 : 0) : targetKeys.length;
    moveTrackToDirector(track, destinationDirector, index);
    return;
  }
  const keys = source.objects.flatMap((object) => object.tracks.map((item) => trackKey(item.target, item.prop)));
  const remainder = keys.filter((key) => key !== activeId);
  let index = beforeKey ? remainder.indexOf(beforeKey) : remainder.length;
  if (intent.type === 'after' && beforeKey) index += 1;
  remainder.splice(Math.max(0, index), 0, activeId);
  reorderTracks(source.directorId, remainder);
}

export function TimelinePanel() {
  const template = useEditor((s) => s.template);
  const selection = useEditor((s) => s.selection);
  const select = useEditor((s) => s.select);
  const playheads = useEditor((s) => s.playheads);
  const playing = useEditor((s) => s.playing);
  const waitingContinue = useEditor((s) => s.waitingContinue);
  const activeDirectorId = useEditor((s) => s.activeDirectorId);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const setGlobalPlayhead = useEditor((s) => s.setGlobalPlayhead);
  const setPlaying = useEditor((s) => s.setPlaying);
  const requestContinue = useEditor((s) => s.requestContinue);
  const setActiveDirector = useEditor((s) => s.setActiveDirector);
  const addDirector = useEditor((s) => s.addDirector);
  const updateDirector = useEditor((s) => s.updateDirector);
  const removeDirector = useEditor((s) => s.removeDirector);
  const addTrackAtPlayhead = useEditor((s) => s.addTrackAtPlayhead);
  const removeTrack = useEditor((s) => s.removeTrack);
  const deletePoint = useEditor((s) => s.deletePoint);
  const setKeyframeValue = useEditor((s) => s.setKeyframeValue);
  const moveTrackToDirector = useEditor((s) => s.moveTrackToDirector);
  const moveObjectToDirector = useEditor((s) => s.moveObjectToDirector);
  const reorderTracks = useEditor((s) => s.reorderTracks);
  const shiftTargetKeyframes = useEditor((s) => s.shiftTargetKeyframes);
  const scaleTargetKeyframes = useEditor((s) => s.scaleTargetKeyframes);
  const shiftSelectedKeyframes = useEditor((s) => s.shiftSelectedKeyframes);
  const selectedActionCueId = useEditor((s) => s.selectedActionCueId);
  const selectActionCue = useEditor((s) => s.selectActionCue);
  const addActionCueAtPlayhead = useEditor((s) => s.addActionCueAtPlayhead);
  const removeSelectedActionCue = useEditor((s) => s.removeSelectedActionCue);
  const moveActionCue = useEditor((s) => s.moveActionCue);
  const [view, setView] = useState<'dope' | 'curve'>('dope');
  const [pxPerFrame, setPxPerFrame] = useState(6);
  const [activeTrack, setActiveTrack] = useState<TimelineTrack | null>(null);
  const [selectedKfs, setSelectedKfs] = useState<SelectedKeyframe[]>([]);
  const [collapsedDirectors, setCollapsedDirectors] = useState<Set<string>>(() => new Set());
  const [collapsedObjects, setCollapsedObjects] = useState<Set<string>>(() => new Set());
  const [dragIntent, setDragIntent] = useState<TrackDragIntent | null>(null);
  const [draggingLabel, setDraggingLabel] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addMenuPos, setAddMenuPos] = useState<{ left: number; top: number } | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [groupDrag, setGroupDrag] = useState<{ delta: number; items: SelectedKeyframe[] } | null>(null);
  const groupDragRef = useRef(groupDrag);
  groupDragRef.current = groupDrag;
  const scrollRef = useRef<HTMLDivElement>(null);
  const addTrackBtnRef = useRef<HTMLButtonElement>(null);
  const pendingScrollLeft = useRef<number | null>(null);
  const seededTemplateId = useRef<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  useLayoutEffect(() => {
    if (!addOpen || !addTrackBtnRef.current) return;
    const rect = addTrackBtnRef.current.getBoundingClientRect();
    setAddMenuPos({ left: rect.left, top: rect.bottom + 6 });
  }, [addOpen]);
  useLayoutEffect(() => {
    if (pendingScrollLeft.current === null) return;
    if (scrollRef.current) scrollRef.current.scrollLeft = pendingScrollLeft.current;
    pendingScrollLeft.current = null;
  }, [pxPerFrame]);
  useEffect(() => {
    if (!template || seededTemplateId.current === template.id) return;
    seededTemplateId.current = template.id;
    const update = template.timeline.directors.find((director) => isUpdateDirectorName(director.name));
    setCollapsedDirectors(update ? new Set([update.id]) : new Set());
    setSelectedKfs([]);
    setCollapsedObjects(new Set());
    setActiveTrack(null);
  }, [template]);

  // Layers / object selection must not keep a prop-track highlight from another object.
  useEffect(() => {
    if (!selection || !activeTrack) return;
    if (!sameTarget(activeTrack.target, { kind: selection.kind, id: selection.id })) {
      setActiveTrack(null);
    }
  }, [selection, activeTrack]);

  if (!template) return null;
  const director = template.timeline.directors.find((item) => item.id === activeDirectorId) ?? template.timeline.directors[0];
  const maxDur = Math.max(template.timeline.durationFrames, ...template.timeline.directors.map((item) => item.durationFrames));
  const globalPlayhead = deriveGlobalPlayhead(template, playheads, activeDirectorId);
  const tree = collectDirectorObjectTree(template);
  const tracks = treeTracks(tree);
  const sortableIds = [...tree.flatMap((item) => item.objects.map((object) => objectTrackKey(object.target))), ...tracks.map((track) => trackKey(track.target, track.prop))];
  const selectedTarget = selection ? { kind: selection.kind, id: selection.id } : null;
  const trackedProps = selectedTarget ? ANIMATABLE_PROPS.filter((prop) => tracks.some((track) => sameTarget(track.target, selectedTarget) && track.prop === prop)) : [];
  const untrackedProps = ANIMATABLE_PROPS.filter((prop) => prop !== 'crawlProgress' && prop !== 'videoProgress' && !trackedProps.includes(prop));
  const activeTrackResolved = (() => {
    if (activeTrack && tracks.some((track) => trackKey(track.target, track.prop) === trackKey(activeTrack.target, activeTrack.prop))) {
      if (!selectedTarget || sameTarget(activeTrack.target, selectedTarget)) return activeTrack;
    }
    if (selectedTarget) return tracks.find((track) => sameTarget(track.target, selectedTarget)) ?? null;
    return tracks[0] ?? null;
  })();
  const timelineWidth = Math.max(maxDur * pxPerFrame + 24, 100);

  function frameFromContentX(clientX: number, element: Element, maxFrame: number): number {
    return Math.min(maxFrame, Math.max(0, Math.round((clientX - element.getBoundingClientRect().left) / pxPerFrame)));
  }
  function zoomTimeline(direction: number) {
    const element = scrollRef.current;
    const fitMin = element
      ? Math.max(0.05, (element.clientWidth - HEADER_W) / Math.max(1, maxDur))
      : 0.25;
    const floor = Math.min(0.25, fitMin);
    const step = pxPerFrame <= 2 ? Math.min(0.25, Math.max(0.05, (pxPerFrame - floor) / 4 || 0.05)) : 2;
    const next = Number(Math.min(24, Math.max(floor, pxPerFrame + direction * step)).toFixed(3));
    if (next === pxPerFrame) return;
    if (element) pendingScrollLeft.current = Math.max(0, element.scrollLeft + globalPlayhead * (next - pxPerFrame));
    setPxPerFrame(next);
  }
  function selectTrack(track: TimelineTrack) {
    if (!template) return;
    select(track.target);
    setActiveTrack(track);
    setActiveDirector(directorForTrack(template, track));
  }
  function selectObject(target: Target) {
    select(target);
    setActiveTrack(null);
    setSelectedKfs([]);
    const objectDirectorId = objectDirector(tree, target)?.directorId;
    if (objectDirectorId) setActiveDirector(objectDirectorId);
  }
  function toggleObject(target: Target) {
    const key = objectTrackKey(target);
    setCollapsedObjects((current) => {
      const next = new Set(current);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }
  function toggleDirector(id: string) {
    setCollapsedDirectors((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function addKeyframe() {
    if (!template || !activeTrackResolved) return;
    const directorId = directorForTrack(template, activeTrackResolved);
    const frame = playheads[directorId] ?? 0;
    const points = keyframePointsFor(activeTrackResolved.target, activeTrackResolved.prop);
    if (points.some((point) => point.frame === frame)) return;
    const added = { target: activeTrackResolved.target, prop: activeTrackResolved.prop, frame };
    setKeyframeValue(added.target, frame, added.prop, sampleValue(points, frame), directorId);
    setSelectedKfs([added]);
  }
  function deleteSelectedKeyframes() {
    selectedKfs.forEach((keyframe) => deletePoint(keyframe.target, keyframe.prop, keyframe.frame));
    setSelectedKfs([]);
  }
  function selectKeyframe(keyframe: SelectedKeyframe, additive = false) {
    setSelectedKfs((current) => additive ? toggleKeyframe(current, keyframe) : [keyframe]);
  }
  function beginMarquee(event: ReactPointerEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    // Playhead rulers / scrub fields — only scrub, never marquee.
    if (target.closest('[data-playhead-scrub]')) return;
    // Marquee only when starting on track/object lanes (not sticky name column alone without lane).
    if (!target.closest('[data-marquee-zone]')) return;
    if (target.closest('[data-kf="1"], [data-action="1"], [data-seg="1"], [data-summary="1"], button, input, select')) return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    event.currentTarget.setPointerCapture(event.pointerId);
    setMarquee({ startX: event.clientX, startY: event.clientY, endX: event.clientX, endY: event.clientY });
  }
  function updateMarquee(event: ReactPointerEvent<HTMLDivElement>) {
    if (marquee && event.buttons === 1) {
      window.getSelection()?.removeAllRanges();
      setMarquee((current) => current ? { ...current, endX: event.clientX, endY: event.clientY } : null);
    }
  }
  function finishMarquee(event: ReactPointerEvent<HTMLDivElement>) {
    if (!marquee) return;
    const left = Math.min(marquee.startX, event.clientX);
    const right = Math.max(marquee.startX, event.clientX);
    const top = Math.min(marquee.startY, event.clientY);
    const bottom = Math.max(marquee.startY, event.clientY);
    const dragged = right - left > 3 || bottom - top > 3;
    if (!dragged) setSelectedKfs([]);
    else {
      const hits: SelectedKeyframe[] = [];
      scrollRef.current?.querySelectorAll<HTMLElement>('[data-kf="1"]').forEach((node) => {
        const rect = node.getBoundingClientRect();
        if (rect.left <= right && rect.right >= left && rect.top <= bottom && rect.bottom >= top) {
          const kind = node.dataset.kind;
          const id = node.dataset.id;
          const prop = node.dataset.prop as AnimatableProp | undefined;
          const frame = Number(node.dataset.frame);
          if ((kind === 'layer' || kind === 'group') && id && prop && Number.isFinite(frame)) hits.push({ target: { kind, id }, prop, frame });
        }
      });
      setSelectedKfs(hits);
    }
    setMarquee(null);
  }
  function onDragStart(event: DragStartEvent) {
    if (!template) return;
    const id = String(event.active.id);
    const object = parseObjectTrackKey(id);
    const track = tracks.find((item) => trackKey(item.target, item.prop) === id);
    setDraggingLabel(object ? targetLabel(template, object) : track ? `${targetLabel(template, track.target)} · ${trackPropLabel(track.prop)}` : null);
  }
  function clearDrag() { setDragIntent(null); setDraggingLabel(null); }
  function onDragEnd(event: DragEndEvent) {
    const intent = computeTrackDragIntent(event, sortableIds) ?? dragIntent;
    clearDrag();
    if (intent) applyTrackDrag(intent, String(event.active.id), tree, moveTrackToDirector, moveObjectToDirector, reorderTracks);
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
        <button type="button" onClick={() => setGlobalPlayhead(0)} className="grid h-7 w-7 place-items-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink" title="Jump to beginning"><SkipBack className="h-4 w-4" /></button>
        <button type="button" onClick={() => setPlaying(!playing)} className="grid h-7 w-7 place-items-center rounded-md text-ink hover:bg-surface-2" title={playing ? 'Pause' : 'Play'}>{playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}</button>
        <button type="button" onClick={requestContinue} disabled={!waitingContinue} className={cn('grid h-7 w-7 place-items-center rounded-md', waitingContinue ? 'text-primary hover:bg-primary/15' : 'cursor-not-allowed text-ink-faint opacity-40')} title="Continue (resume stop and wait)"><ChevronsRight className="h-4 w-4" /></button>
        <button type="button" onClick={() => setPlaying(false)} className="grid h-7 w-7 place-items-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink" title="Stop"><Square className="h-3.5 w-3.5" /></button>
        <span className="w-28 text-center text-[12px] tabular-nums text-white/90">{Math.round(globalPlayhead)} / {maxDur}</span>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" onClick={() => setView('dope')} className={cn('grid h-7 w-7 place-items-center rounded-md', view === 'dope' ? 'bg-primary/20 text-ink' : 'text-ink-muted hover:bg-surface-2')} title="Dope sheet"><ListTree className="h-4 w-4" /></button>
          <button type="button" onClick={() => setView('curve')} className={cn('grid h-7 w-7 place-items-center rounded-md', view === 'curve' ? 'bg-primary/20 text-ink' : 'text-ink-muted hover:bg-surface-2')} title="Curve editor"><Activity className="h-4 w-4" /></button>
          <button type="button" onClick={() => zoomTimeline(-1)} className="px-1.5 text-ink-muted hover:text-ink" title="Zoom out">-</button>
          <button type="button" onClick={() => zoomTimeline(1)} className="px-1.5 text-ink-muted hover:text-ink" title="Zoom in">+</button>
        </div>
      </div>
      {director && <div className="flex h-8 shrink-0 items-center gap-3 border-b border-border px-2 text-[12px] text-ink-muted">
        <span className="font-medium text-ink">{director.name}</span>
        <label className="flex items-center gap-1.5">Dur <NumberInput value={director.durationFrames} onChange={(value) => updateDirector(director.id, { durationFrames: Math.max(1, Math.round(value)) })} className="h-6 w-16" /></label>
        <label className="flex items-center gap-1.5">Offset <NumberInput value={director.offsetFrames} onChange={(value) => updateDirector(director.id, { offsetFrames: Math.max(0, Math.round(value)) })} className="h-6 w-16" /></label>
        <Checkbox label="loop" checked={director.loop} onChange={(value) => updateDirector(director.id, { loop: value })} />
        <Checkbox label="swing" checked={director.swing} onChange={(value) => updateDirector(director.id, { swing: value })} />
        <Checkbox label="autostart" checked={director.autostart} onChange={(value) => updateDirector(director.id, { autostart: value })} />
      </div>}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-2">
        <button ref={addTrackBtnRef} type="button" onClick={() => setAddOpen((open) => !open)} disabled={!selectedTarget || !untrackedProps.length} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-ink-muted hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40" title="Add track"><Plus className="h-3.5 w-3.5" /><span className="text-[11px]">Track</span></button>
        <button type="button" onClick={addDirector} className="rounded-md px-1.5 py-1 text-ink-muted hover:bg-surface-2 hover:text-ink" title="Add director"><KbdBadge>+D</KbdBadge></button>
        <button type="button" disabled={!activeTrackResolved} onClick={addKeyframe} className="rounded-md px-1.5 py-1 text-ink-muted hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40" title="Add keyframe"><KbdBadge>+K</KbdBadge></button>
        <button type="button" disabled={!selectedKfs.length} onClick={deleteSelectedKeyframes} className="rounded-md px-1.5 py-1 text-ink-muted hover:bg-surface-2 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40" title="Delete selected keyframes (-K)"><KbdBadge>-K</KbdBadge></button>
        <button type="button" onClick={() => { setSelectedKfs([]); addActionCueAtPlayhead(); }} className="rounded-md px-1.5 py-1 text-ink-muted hover:bg-surface-2 hover:text-ink" title="Add action at playhead"><KbdBadge>+A</KbdBadge></button>
        <button type="button" disabled={!selectedActionCueId} onClick={removeSelectedActionCue} className="rounded-md px-1.5 py-1 text-ink-muted hover:bg-surface-2 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40" title="Delete selected action cue"><KbdBadge>-A</KbdBadge></button>
      </div>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto select-none"
        onPointerDown={beginMarquee}
        onPointerMove={updateMarquee}
        onPointerUp={finishMarquee}
      >
        <DndContext sensors={sensors} collisionDetection={timelineCollision} onDragStart={onDragStart} onDragMove={(event) => setDragIntent(computeTrackDragIntent(event, sortableIds))} onDragOver={(event) => setDragIntent(computeTrackDragIntent(event, sortableIds))} onDragEnd={onDragEnd} onDragCancel={(_event: DragCancelEvent) => clearDrag()}>
          <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
            <div style={{ width: HEADER_W + timelineWidth }}>
              {view === 'dope' && <>
                <GlobalPlayheadRow maxDur={maxDur} pxPerFrame={pxPerFrame} timelineWidth={timelineWidth} playhead={globalPlayhead} smooth={playing} onScrub={(event, element) => { setPlaying(false); setGlobalPlayhead(frameFromContentX(event.clientX, element, maxDur)); }} />
                {tree.map(({ directorId, objects }) => {
                  const item = template.timeline.directors.find((entry) => entry.id === directorId);
                  if (!item) return null;
                  const collapsed = collapsedDirectors.has(directorId);
                  const cues = template.timeline.actions.filter((cue) => cue.directorId === directorId);
                  const hasActions = cues.length > 0;
                  return <DirectorSection key={directorId} dropActive={dragIntent?.type === 'director' && dragIntent.directorId === directorId}>
                    <div className="flex">
                      <div className={cn('sticky left-0 shrink-0', STICKY)} style={{ width: HEADER_W }}>
                        <DirectorHeader name={item.name} selected={activeDirectorId === directorId} collapsed={collapsed} canRemove={!isUpdateDirectorName(item.name)} onToggleCollapse={() => toggleDirector(directorId)} onSelect={() => setActiveDirector(directorId)} onRemove={() => removeDirector(directorId)} />
                        {!collapsed && hasActions && <div className={cn('flex items-center border-b border-r border-border/40 px-2 text-[10px] font-semibold uppercase tracking-wide text-ink-faint', DIRECTOR_BG, HEADER_SHADOW)} style={{ height: ACTION_LANE_H }}>Actions</div>}
                      </div>
                      <div className="relative shrink-0" style={{ width: timelineWidth }}>
                        <DirectorRuler dur={item.durationFrames} pxPerFrame={pxPerFrame} onScrub={(event, element) => { setPlaying(false); setActiveDirector(directorId); setPlayhead(directorId, frameFromContentX(event.clientX, element, item.durationFrames)); }} />
                        {!collapsed && hasActions && (
                          <ActionLane
                            cues={cues}
                            pxPerFrame={pxPerFrame}
                            dur={item.durationFrames}
                            selectedId={selectedActionCueId}
                            onSelect={(id) => { setSelectedKfs([]); selectActionCue(id); }}
                            onMove={moveActionCue}
                            frameFromEvent={(event, element) => frameFromContentX(event.clientX, element, item.durationFrames)}
                          />
                        )}
                        <div className={cn('pointer-events-none absolute top-0 z-sticky w-px bg-live', playing && 'transition-[left] duration-[70ms] ease-linear')} style={{ left: (playheads[directorId] ?? 0) * pxPerFrame, height: DIRECTOR_HDR_H + (!collapsed && hasActions ? ACTION_LANE_H : 0) }}><div className="absolute -left-1 top-0 h-2 w-2 rounded-sm bg-live" /></div>
                      </div>
                    </div>
                    {!collapsed && objects.map((object) => {
                      const objectKey = objectTrackKey(object.target);
                      const span = targetKeyframeSpan(template, object.target);
                      const objectCollapsed = collapsedObjects.has(objectKey);
                      const objectSelected = !!selectedTarget && sameTarget(selectedTarget, object.target);
                      return <ObjectTrackGroup key={objectKey} objectId={objectKey} target={object.target} label={targetLabel(template, object.target)} span={span} pxPerFrame={pxPerFrame} dur={item.durationFrames} timelineWidth={timelineWidth} selected={objectSelected} collapsed={objectCollapsed} groupDrag={groupDrag} dropBefore={dragIntent?.type === 'before' && dragIntent.trackId === objectKey} dropAfter={dragIntent?.type === 'after' && dragIntent.trackId === objectKey} onToggle={() => toggleObject(object.target)} onSelect={() => selectObject(object.target)} onShift={shiftTargetKeyframes} onScale={scaleTargetKeyframes}>
                        {!objectCollapsed && object.tracks.map((track) => {
                          const video = track.prop === 'videoProgress' && track.target.kind === 'layer';
                          const videoLayer = video ? template.layers.find((layer) => layer.id === track.target.id && layer.type === 'video') : null;
                          return <SortableTrackRow key={trackKey(track.target, track.prop)} trackId={trackKey(track.target, track.prop)} label={video ? targetLabel(template, track.target) : trackPropLabel(track.prop)} labelExtra={videoLayer?.type === 'video' && videoLayer.loop ? <InfinityIcon className="h-3.5 w-3.5 text-primary" aria-label="Loop" /> : null} active={
                            (!!activeTrack && trackKey(activeTrack.target, activeTrack.prop) === trackKey(track.target, track.prop))
                            || (objectSelected && !activeTrack)
                          } dropBefore={dragIntent?.type === 'before' && dragIntent.trackId === trackKey(track.target, track.prop)} dropAfter={dragIntent?.type === 'after' && dragIntent.trackId === trackKey(track.target, track.prop)} onSelect={() => selectTrack(track)} onRemove={() => { removeTrack(track.target, track.prop); setSelectedKfs((items) => items.filter((item) => !sameTarget(item.target, track.target) || item.prop !== track.prop)); }} timelineWidth={timelineWidth} lane={video ? <VideoClipLane layerId={track.target.id} pxPerFrame={pxPerFrame} dur={item.durationFrames} loop={videoLayer?.type === 'video' && videoLayer.loop} /> : <DopeLane target={track.target} prop={track.prop} pxPerFrame={pxPerFrame} dur={item.durationFrames} selectedKfs={selectedKfs} groupDrag={groupDrag} onSelectKeyframe={selectKeyframe} onGroupDragStart={(from, additive) => {
                            const moving = !additive && !isSelectedKeyframe(selectedKfs, from.target, from.prop, from.frame)
                              ? [from]
                              : (isSelectedKeyframe(selectedKfs, from.target, from.prop, from.frame) ? selectedKfs : [...selectedKfs, from]);
                            setGroupDrag({ delta: 0, items: moving });
                          }} onGroupDragDelta={(delta) => setGroupDrag((current) => current ? { ...current, delta } : null)} onGroupDragEnd={(from, delta) => {
                            const items = groupDragRef.current?.items ?? (isSelectedKeyframe(selectedKfs, from.target, from.prop, from.frame) ? selectedKfs : [from]);
                            setGroupDrag(null);
                            if (!delta) return;
                            const moved = shiftSelectedKeyframes(items, delta);
                            if (moved) setSelectedKfs(moved);
                            else setSelectedKfs(items);
                          }} />} />;
                        })}
                      </ObjectTrackGroup>;
                    })}
                    {!collapsed && (objects.length ? <DirectorEndDropPad directorId={directorId} active={dragIntent?.type === 'director' && dragIntent.directorId === directorId} /> : <DirectorDropLane directorId={directorId} timelineWidth={timelineWidth} active={dragIntent?.type === 'director' && dragIntent.directorId === directorId} />)}
                  </DirectorSection>;
                })}
              </>}
              {view === 'curve' && activeTrackResolved && <div className="flex"><div className={cn('sticky left-0 shrink-0 border-r border-border px-2 py-1 text-[12px] text-ink', STICKY, HEADER_BG, HEADER_SHADOW)} style={{ width: HEADER_W }}>{targetLabel(template, activeTrackResolved.target)} · {trackPropLabel(activeTrackResolved.prop)}</div><CurveView target={activeTrackResolved.target} prop={activeTrackResolved.prop} pxPerFrame={pxPerFrame} dur={director?.durationFrames ?? maxDur} selectedKfs={selectedKfs} onSelectKeyframe={selectKeyframe} onClearSelection={() => setSelectedKfs([])} /></div>}
              {view === 'curve' && !activeTrackResolved && <p className="p-3 text-[12px] text-ink-faint">Add a track to edit its curve.</p>}
            </div>
          </SortableContext>
          <DragOverlay dropAnimation={null}>{draggingLabel && <TrackDragOverlay label={draggingLabel} />}</DragOverlay>
        </DndContext>
      </div>
      {marquee && <div className="pointer-events-none fixed z-[100] border border-primary bg-primary/10" style={{ left: Math.min(marquee.startX, marquee.endX), top: Math.min(marquee.startY, marquee.endY), width: Math.abs(marquee.endX - marquee.startX), height: Math.abs(marquee.endY - marquee.startY) }} />}
      {addOpen && addMenuPos && createPortal(<><button type="button" className="fixed inset-0 z-[200] cursor-default" aria-label="Close add track menu" onClick={() => setAddOpen(false)} /><div className="fixed z-[201] grid max-h-48 w-32 grid-cols-2 gap-0.5 overflow-auto rounded-md border border-border bg-surface p-1 shadow-2xl" style={addMenuPos}>{untrackedProps.map((prop) => <button key={prop} type="button" onClick={() => { if (!selectedTarget) return; addTrackAtPlayhead(selectedTarget, prop); setActiveTrack({ target: selectedTarget, prop }); setAddOpen(false); }} className="rounded px-1 py-1 text-left text-[11px] text-ink hover:bg-surface-2">{trackPropLabel(prop)}</button>)}</div></>, document.body)}
    </div>
  );
}

function TrackDragOverlay({ label }: { label: string }) {
  return <div style={{ width: HEADER_W, height: LANE_H }} className="flex items-center gap-1 rounded-md border border-primary/50 bg-surface px-1 shadow-lg ring-2 ring-primary/30"><GripVertical className="h-3.5 w-3.5 text-primary" /><span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">{label}</span></div>;
}

function DirectorSection({ children, dropActive }: { children: ReactNode; dropActive?: boolean }) {
  return <div className={cn('border-b border-border/30', dropActive && 'bg-primary/10 ring-1 ring-inset ring-primary/35')}>{children}</div>;
}

function DirectorDropLane({ directorId, timelineWidth, active }: { directorId: string; timelineWidth: number; active?: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: `director:${directorId}` });
  return <div ref={setNodeRef} className={cn('relative flex', (active || isOver) && 'bg-primary/10')}><div className={cn('sticky left-0 shrink-0 border-r border-border/40 px-2 py-1 text-[11px] text-ink-faint', STICKY, HEADER_BG, HEADER_SHADOW)} style={{ width: HEADER_W, height: LANE_H }}>Drop track here</div><div style={{ width: timelineWidth, height: LANE_H }} className="border-b border-border/20 bg-surface/30" /></div>;
}

function DirectorEndDropPad({ directorId, active }: { directorId: string; active?: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: `director:${directorId}` });
  return <div ref={setNodeRef} className={cn('h-3', (active || isOver) && 'bg-primary/20')} />;
}

function TrackDropLine({ position }: { position: 'before' | 'after' }) {
  return <div className={cn('pointer-events-none absolute inset-x-0 z-20 h-1 bg-primary', position === 'before' ? '-top-px' : '-bottom-px')} />;
}

function ObjectTrackGroup({ objectId, target, label, span, pxPerFrame, dur, timelineWidth, selected, collapsed, groupDrag, dropBefore, dropAfter, onToggle, onSelect, onShift, onScale, children }: {
  objectId: string;
  target: Target;
  label: string;
  span: { min: number; max: number } | null;
  pxPerFrame: number;
  dur: number;
  timelineWidth: number;
  selected: boolean;
  collapsed: boolean;
  groupDrag: { delta: number; items: SelectedKeyframe[] } | null;
  dropBefore?: boolean;
  dropAfter?: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onShift: (target: Target, delta: number) => void;
  onScale: (target: Target, min: number, max: number) => void;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({ id: objectId, animateLayoutChanges: () => false });
  return (
    <div ref={setNodeRef} className={cn('relative', isDragging && 'opacity-30')} data-marquee-zone="1">
      {dropBefore && <TrackDropLine position="before" />}
      {dropAfter && <TrackDropLine position="after" />}
      <div className="flex">
        <div
          style={{ width: HEADER_W, height: LANE_H }}
          className={cn(
            'sticky left-0 flex shrink-0 items-center gap-0.5 border-r border-border/40 pl-1 pr-1 select-none',
            STICKY, HEADER_BG, HEADER_SHADOW,
            selected ? 'bg-primary/10 text-ink ring-1 ring-inset ring-primary/35' : 'text-ink-muted hover:bg-surface-2',
          )}
        >
          <button type="button" className="grid h-5 w-5 place-items-center rounded text-ink-faint hover:bg-surface-2 hover:text-ink" onClick={onToggle} aria-label={collapsed ? 'Expand object tracks' : 'Collapse object tracks'}>
            {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
          <button type="button" className="grid h-5 w-5 cursor-grab place-items-center text-ink-faint hover:text-ink" {...attributes} {...listeners} aria-label={`Reorder ${label}`}>
            <GripVertical className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={onSelect} className="min-w-0 flex-1 truncate text-left text-[12px] font-medium">{label}</button>
        </div>
        <ObjectSummaryLane target={target} span={span} pxPerFrame={pxPerFrame} dur={dur} timelineWidth={timelineWidth} selected={selected} groupDrag={groupDrag} onShift={onShift} onScale={onScale} />
      </div>
      {!collapsed && children}
    </div>
  );
}

function previewSpanForTarget(
  target: Target,
  span: { min: number; max: number } | null,
  groupDrag: { delta: number; items: SelectedKeyframe[] } | null,
): { min: number; max: number } | null {
  if (!span) return null;
  if (!groupDrag || groupDrag.delta === 0) return span;
  const related = groupDrag.items.filter((item) => sameTarget(item.target, target));
  if (related.length === 0) return span;
  let min = span.min;
  let max = span.max;
  for (const item of related) {
    const frame = Math.max(0, item.frame + groupDrag.delta);
    if (frame < min) min = frame;
    if (frame > max) max = frame;
  }
  // Also account for non-dragged keyframes that stay put — span already includes them via min/max.
  // When dragging a subset, unmoved frames keep old span edges unless dragged ones go outside.
  return { min, max };
}

function ObjectSummaryLane({ target, span, pxPerFrame, dur, timelineWidth, selected, groupDrag, onShift, onScale }: {
  target: Target;
  span: { min: number; max: number } | null;
  pxPerFrame: number;
  dur: number;
  timelineWidth: number;
  selected: boolean;
  groupDrag: { delta: number; items: SelectedKeyframe[] } | null;
  onShift: (target: Target, delta: number) => void;
  onScale: (target: Target, min: number, max: number) => void;
}) {
  const [drag, setDrag] = useState<{ kind: 'move' | 'start' | 'end'; startX: number; min: number; max: number; current: number } | null>(null);
  const laneWidth = Math.max(dur * pxPerFrame + 24, 100);
  const preview = previewSpanForTarget(target, span, groupDrag);
  if (!preview && !span) {
    return <div style={{ width: timelineWidth, height: LANE_H }} className={cn('border-b border-border/40', selected && 'bg-primary/10')} />;
  }
  const base = preview ?? span!;
  const min = drag?.kind === 'start' ? drag.current : drag?.kind === 'move' ? Math.max(0, base.min + Math.round((drag.current - drag.startX) / pxPerFrame)) : base.min;
  const max = drag?.kind === 'end' ? drag.current : drag?.kind === 'move' ? Math.max(0, base.max + Math.round((drag.current - drag.startX) / pxPerFrame)) : base.max;
  const commit = () => {
    if (!drag || !span) return;
    if (drag.kind === 'move') onShift(target, Math.round((drag.current - drag.startX) / pxPerFrame));
    else onScale(target, drag.kind === 'start' ? drag.current : span.min, drag.kind === 'end' ? drag.current : span.max);
    setDrag(null);
  };
  return (
    <div style={{ width: timelineWidth, height: LANE_H }} className={cn('relative overflow-hidden border-b border-border/40', selected && 'bg-primary/10')}>
      <div
        data-summary="1"
        className="absolute top-1 flex h-[18px] cursor-grab items-center rounded-sm border border-primary/55 bg-primary/30 active:cursor-grabbing"
        style={{ left: min * pxPerFrame, width: Math.max(6, (max - min) * pxPerFrame || 6) }}
        onPointerDown={(event) => {
          if (!span) return;
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          const rect = event.currentTarget.getBoundingClientRect();
          const edge = Math.min(6, rect.width / 3);
          const kind = event.clientX - rect.left <= edge ? 'start' : rect.right - event.clientX <= edge ? 'end' : 'move';
          setDrag({ kind, startX: event.clientX, min: span.min, max: span.max, current: kind === 'start' ? span.min : kind === 'end' ? span.max : event.clientX });
        }}
        onPointerMove={(event) => {
          if (!drag || event.buttons !== 1) return;
          if (drag.kind === 'move') setDrag({ ...drag, current: event.clientX });
          else {
            const lane = event.currentTarget.parentElement;
            if (lane) setDrag({ ...drag, current: Math.max(0, Math.round((event.clientX - lane.getBoundingClientRect().left) / pxPerFrame)) });
          }
        }}
        onPointerUp={commit}
        onPointerCancel={() => setDrag(null)}
      >
        <span className="absolute inset-y-0 left-0 w-1 cursor-ew-resize" />
        <span className="absolute inset-y-0 right-0 w-1 cursor-ew-resize" />
      </div>
      <div style={{ width: laneWidth }} />
    </div>
  );
}

function deriveGlobalPlayhead(template: NonNullable<ReturnType<typeof useEditor.getState>['template']>, playheads: Record<string, number>, activeDirectorId: string): number {
  const values = template.timeline.directors.map((director) => playheads[director.id] ?? 0);
  return values.every((value) => value === values[0]) ? values[0] ?? 0 : playheads[activeDirectorId] ?? values[0] ?? 0;
}

function GlobalPlayheadRow({ maxDur, pxPerFrame, timelineWidth, playhead, smooth, onScrub }: { maxDur: number; pxPerFrame: number; timelineWidth: number; playhead: number; smooth: boolean; onScrub: (event: ReactPointerEvent, element: Element) => void }) {
  return (
    <div className="flex border-b border-border bg-surface-2/80" data-playhead-scrub="1">
      <div style={{ width: HEADER_W, height: DIRECTOR_HDR_H }} className={cn('sticky left-0 flex shrink-0 items-center border-r border-border/60 px-2 text-[11px] font-semibold text-white', STICKY, DIRECTOR_BG, HEADER_SHADOW)}>Global</div>
      <div className="relative shrink-0" style={{ width: timelineWidth }}>
        <DirectorRuler dur={maxDur} pxPerFrame={pxPerFrame} onScrub={onScrub} className="bg-surface-2/60" />
        <div className={cn('pointer-events-none absolute top-0 z-sticky w-0.5 bg-white/95', smooth && 'transition-[left] duration-[70ms] ease-linear')} style={{ left: playhead * pxPerFrame, height: DIRECTOR_HDR_H }} />
      </div>
    </div>
  );
}

function ActionLane({
  cues, pxPerFrame, dur, selectedId, onSelect, onMove, frameFromEvent,
}: {
  cues: { id: string; frame: number; fromEnd?: boolean; name: string; items: unknown[] }[];
  pxPerFrame: number;
  dur: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMove: (id: string, frame: number) => void;
  frameFromEvent: (event: ReactPointerEvent, element: Element) => number;
}) {
  const [drag, setDrag] = useState<{ id: string; frame: number } | null>(null);
  return (
    <div
      className="relative border-b border-border/60 bg-surface/40"
      style={{ height: ACTION_LANE_H, width: Math.max(1, dur) * pxPerFrame + 40 }}
    >
      {cues.map((cue) => {
        const base = effectiveActionFrame(cue, dur);
        const frame = drag?.id === cue.id ? drag.frame : base;
        const title = cue.name.trim()
          ? cue.name
          : cue.fromEnd
            ? `Action @ end-${cue.frame} (=${base})`
            : `Action @ ${base}`;
        return (
          <div
            key={cue.id}
            data-action="1"
            title={title}
            className={cn(
              'absolute top-1/2 z-10 h-3 w-3 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-sm border',
              selectedId === cue.id
                ? 'border-live bg-live'
                : cue.fromEnd
                  ? 'border-amber-300/90 bg-amber-400/70'
                  : 'border-amber-400/80 bg-amber-500/80',
            )}
            style={{ left: frame * pxPerFrame }}
            onPointerDown={(event) => {
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              onSelect(cue.id);
              setDrag({ id: cue.id, frame: base });
            }}
            onPointerMove={(event) => {
              const lane = event.currentTarget.parentElement;
              if (drag?.id === cue.id && event.buttons === 1 && lane) {
                setDrag({ id: cue.id, frame: frameFromEvent(event, lane) });
              }
            }}
            onPointerUp={(event) => {
              const lane = event.currentTarget.parentElement;
              if (drag?.id === cue.id && lane) onMove(cue.id, frameFromEvent(event, lane));
              setDrag(null);
            }}
            onPointerCancel={() => setDrag(null)}
          />
        );
      })}
    </div>
  );
}

function DirectorHeader({ name, selected, collapsed, canRemove, onToggleCollapse, onSelect, onRemove }: { name: string; selected: boolean; collapsed: boolean; canRemove: boolean; onToggleCollapse: () => void; onSelect: () => void; onRemove: () => void }) {
  return <div style={{ width: HEADER_W, height: DIRECTOR_HDR_H }} className={cn('group flex items-center gap-0.5 border-r border-border/60 pl-1 pr-2 text-[11px] font-semibold', DIRECTOR_BG, selected ? 'text-ink ring-1 ring-inset ring-primary/25' : 'text-ink-muted')}><button type="button" onClick={(event) => { event.stopPropagation(); onToggleCollapse(); }} className="grid h-5 w-5 place-items-center rounded text-ink-faint hover:bg-surface hover:text-ink" aria-label={collapsed ? 'Expand director' : 'Collapse director'}>{collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}</button><button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-1 text-left"><span className="relative inline-grid h-3.5 w-3.5 place-items-center"><Folder className="h-3.5 w-3.5 text-primary/80" /><span className="absolute text-[7px] font-bold text-primary">D</span></span><span className="truncate">{name}</span></button>{canRemove && <button type="button" onClick={onRemove} title="Remove director" className="grid h-5 w-5 place-items-center text-ink-faint opacity-0 hover:text-danger group-hover:opacity-100"><Trash2 className="h-3 w-3" /></button>}</div>;
}

function DirectorRuler({ dur, pxPerFrame, onScrub, className }: { dur: number; pxPerFrame: number; onScrub: (event: ReactPointerEvent, element: Element) => void; className?: string }) {
  const step = pxPerFrame < 1 ? 100 : pxPerFrame < 4 ? 50 : pxPerFrame < 10 ? 25 : 10;
  const ticks: number[] = [];
  for (let frame = 0; frame <= dur; frame += step) ticks.push(frame);
  return (
    <div
      data-playhead-scrub="1"
      className={cn('relative cursor-pointer select-none border-b border-border/40 bg-surface/80', className)}
      style={{ height: DIRECTOR_HDR_H, width: Math.max(dur * pxPerFrame + 24, 100) }}
      onPointerDown={(event) => {
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        onScrub(event, event.currentTarget);
      }}
      onPointerMove={(event) => {
        if (event.buttons === 1) onScrub(event, event.currentTarget);
      }}
    >
      {ticks.map((frame) => (
        <div key={frame} className="absolute top-0 h-full border-l border-border/50 pl-1 text-[10px] tabular-nums text-ink-faint" style={{ left: frame * pxPerFrame }}>
          {frame}
        </div>
      ))}
    </div>
  );
}

function SortableTrackRow({ trackId, label, labelExtra, active, dropBefore, dropAfter, onSelect, onRemove, timelineWidth, lane }: { trackId: string; label: string; labelExtra?: ReactNode; active: boolean; dropBefore?: boolean; dropAfter?: boolean; onSelect: () => void; onRemove: () => void; timelineWidth: number; lane: ReactNode }) {
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({ id: trackId, animateLayoutChanges: () => false });
  return <div ref={setNodeRef} className={cn('relative flex select-none', isDragging && 'opacity-30')}>{dropBefore && <TrackDropLine position="before" />}{dropAfter && <TrackDropLine position="after" />}<div style={{ width: HEADER_W, height: LANE_H }} className={cn('sticky left-0 flex shrink-0 items-center gap-0.5 border-r border-border/40 pl-11 pr-1 select-none', STICKY, HEADER_BG, HEADER_SHADOW, active ? 'bg-primary/10 text-ink ring-1 ring-inset ring-primary/25' : 'text-ink-muted hover:bg-surface-2')}><button type="button" className="grid h-5 w-5 shrink-0 cursor-grab place-items-center text-ink-faint hover:text-ink" {...attributes} {...listeners} aria-label={`Reorder ${label}`}><GripVertical className="h-3.5 w-3.5" /></button><button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-1 truncate text-left text-[12px]"><span className="truncate">{label}</span>{labelExtra}</button><button type="button" onClick={onRemove} title="Remove track" className="grid h-5 w-5 place-items-center text-ink-faint hover:text-danger"><Trash2 className="h-3 w-3" /></button></div><div style={{ width: timelineWidth }} className={cn('relative', active && 'bg-primary/10')}>{lane}</div></div>;
}

function keyframePointsFor(target: Target, prop: AnimatableProp): Point[] {
  const template = useEditor.getState().template;
  if (!template) return [];
  return template.timeline.keyframes.flatMap((keyframe) => {
    const bag = (target.kind === 'layer' ? keyframe.layers : keyframe.groups)[target.id];
    return bag?.[prop] !== undefined ? [{ frame: keyframe.frame, value: bag[prop] as number, easing: keyframe.easing }] : [];
  }).sort((a, b) => a.frame - b.frame);
}

function VideoClipLane({ layerId, pxPerFrame, dur, loop }: { layerId: string; pxPerFrame: number; dur: number; loop: boolean }) {
  const template = useEditor((s) => s.template);
  const patch = useEditor((s) => s.patch);
  const [drag, setDrag] = useState<{ startX: number; delta: number } | null>(null);
  const window = template ? getVideoClipWindow(template, layerId) : null;
  const laneWidth = Math.max(dur * pxPerFrame + 24, 100);
  if (!window) return <div style={{ height: LANE_H, width: laneWidth }} className="border-b border-border/40" />;
  const start = Math.max(0, window.start + (drag?.delta ?? 0));
  return <div className="relative overflow-hidden border-b border-border/40" style={{ height: LANE_H, width: laneWidth }}><div className="absolute top-1 flex h-[18px] cursor-grab items-center gap-1 rounded-sm border border-primary/50 bg-primary/35 px-1.5 active:cursor-grabbing" style={{ left: start * pxPerFrame, width: Math.max(4, (window.end - window.start) * pxPerFrame) }} onPointerDown={(event) => { event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); setDrag({ startX: event.clientX, delta: 0 }); }} onPointerMove={(event) => { if (drag) setDrag({ ...drag, delta: Math.round((event.clientX - drag.startX) / pxPerFrame) }); }} onPointerUp={() => { if (drag?.delta) patch((next) => { moveVideoClip(next, layerId, drag.delta); }); setDrag(null); }}>{loop && <InfinityIcon className="h-3 w-3 text-primary-ink/90" />}<span className="text-[10px] tabular-nums text-ink">{window.end - window.start}f</span></div></div>;
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

function DopeLane({ target, prop, pxPerFrame, dur, selectedKfs, groupDrag, onSelectKeyframe, onGroupDragStart, onGroupDragDelta, onGroupDragEnd }: {
  target: Target;
  prop: AnimatableProp;
  pxPerFrame: number;
  dur: number;
  selectedKfs: SelectedKeyframe[];
  groupDrag: { delta: number; items: SelectedKeyframe[] } | null;
  onSelectKeyframe: (keyframe: SelectedKeyframe, additive?: boolean) => void;
  onGroupDragStart: (from: SelectedKeyframe, additive: boolean) => void;
  onGroupDragDelta: (delta: number) => void;
  onGroupDragEnd: (from: SelectedKeyframe, delta: number) => void;
}) {
  const moveKeyframeSegment = useEditor((s) => s.moveKeyframeSegment);
  type DragState =
    | { kind: 'keyframe'; from: SelectedKeyframe; startX: number; delta: number }
    | { kind: 'segment'; edge: number; startX: number; delta: number };
  const dragRef = useRef<DragState | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const points = keyframePointsFor(target, prop);
  const width = Math.max(dur * pxPerFrame + 24, 100);
  const movingSeg = drag?.kind === 'segment' ? segmentComponentIndices(points, drag.edge) : null;

  function setDragBoth(next: DragState | null) {
    dragRef.current = next;
    setDrag(next);
  }

  function displayedFrame(point: Point, index: number): number {
    if (drag?.kind === 'segment' && movingSeg?.has(index)) {
      return Math.max(0, point.frame + drag.delta);
    }
    if (groupDrag && groupDrag.items.some((item) => isSameKeyframe(item, target, prop, point.frame))) {
      return Math.max(0, point.frame + groupDrag.delta);
    }
    return point.frame;
  }

  function endKeyframeDrag(commit: boolean) {
    const current = dragRef.current;
    if (current?.kind === 'keyframe') {
      onGroupDragEnd(current.from, commit ? current.delta : 0);
    }
    setDragBoth(null);
  }

  return (
    <div className="relative overflow-hidden border-b border-border/40" style={{ height: LANE_H, width }}>
      {points.slice(0, -1).map((point, index) => {
        const next = points[index + 1]!;
        if (point.value === next.value) return null;
        const x1 = displayedFrame(point, index) * pxPerFrame;
        const x2 = displayedFrame(next, index + 1) * pxPerFrame;
        return (
          <div
            key={`${point.frame}-${next.frame}`}
            data-seg="1"
            className="absolute top-1/2 z-[1] h-1 -translate-y-1/2 cursor-ew-resize bg-primary/55"
            style={{ left: Math.min(x1, x2), width: Math.max(2, Math.abs(x2 - x1)) }}
            onPointerDown={(event) => {
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              setDragBoth({ kind: 'segment', edge: index, startX: event.clientX, delta: 0 });
            }}
            onPointerMove={(event) => {
              const current = dragRef.current;
              if (current?.kind !== 'segment' || event.buttons !== 1) return;
              setDragBoth({ ...current, delta: Math.round((event.clientX - current.startX) / pxPerFrame) });
            }}
            onPointerUp={() => {
              const current = dragRef.current;
              if (current?.kind === 'segment' && current.delta) {
                moveKeyframeSegment(target, prop, current.edge, current.delta);
              }
              setDragBoth(null);
            }}
            onPointerCancel={() => setDragBoth(null)}
          />
        );
      })}
      {points.map((point, index) => {
        const item = { target, prop, frame: point.frame };
        const selected = isSelectedKeyframe(selectedKfs, target, prop, point.frame)
          || !!groupDrag?.items.some((entry) => isSameKeyframe(entry, target, prop, point.frame));
        return (
          <div
            key={point.frame}
            data-kf="1"
            data-kind={target.kind}
            data-id={target.id}
            data-prop={prop}
            data-frame={point.frame}
            title={`${trackPropLabel(prop)} @ ${point.frame} = ${point.value}`}
            className={cn(
              'absolute top-1/2 z-[2] h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-grab rounded-[2px] border',
              selected ? 'border-live bg-live/85' : 'border-primary bg-primary/70',
            )}
            style={{ left: displayedFrame(point, index) * pxPerFrame }}
            onPointerDown={(event) => {
              event.stopPropagation();
              event.preventDefault();
              window.getSelection()?.removeAllRanges();
              event.currentTarget.setPointerCapture(event.pointerId);
              const additive = event.shiftKey || event.ctrlKey || event.metaKey;
              onSelectKeyframe(item, additive);
              onGroupDragStart(item, additive);
              setDragBoth({ kind: 'keyframe', from: item, startX: event.clientX, delta: 0 });
            }}
            onPointerMove={(event) => {
              const current = dragRef.current;
              if (current?.kind !== 'keyframe' || event.buttons !== 1) return;
              const delta = Math.round((event.clientX - current.startX) / pxPerFrame);
              if (delta === current.delta) return;
              setDragBoth({ ...current, delta });
              onGroupDragDelta(delta);
            }}
            onPointerUp={() => endKeyframeDrag(true)}
            onPointerCancel={() => endKeyframeDrag(false)}
          />
        );
      })}
    </div>
  );
}

function CurveView({ target, prop, pxPerFrame, dur, selectedKfs, onSelectKeyframe, onClearSelection }: { target: Target; prop: AnimatableProp; pxPerFrame: number; dur: number; selectedKfs: SelectedKeyframe[]; onSelectKeyframe: (keyframe: SelectedKeyframe, additive?: boolean) => void; onClearSelection: () => void }) {
  const setKeyframeValue = useEditor((s) => s.setKeyframeValue);
  const movePoint = useEditor((s) => s.movePoint);
  const deletePoint = useEditor((s) => s.deletePoint);
  const setKeyframeEasing = useEditor((s) => s.setKeyframeEasing);
  const [drag, setDrag] = useState<{ from: number; frame: number; value: number } | null>(null);
  const points = keyframePointsFor(target, prop);
  const width = Math.max(dur * pxPerFrame + 24, 100);
  const height = 150;
  let min = Math.min(0, ...points.map((point) => point.value));
  let max = Math.max(1, ...points.map((point) => point.value));
  if (min === max) { min -= 1; max += 1; }
  const padding = (max - min) * 0.15;
  min -= padding; max += padding;
  const y = (value: number) => height - ((value - min) / (max - min)) * height;
  const valueAt = (value: number) => min + (1 - value / height) * (max - min);
  const path = points.flatMap((point, index) => { if (!index) return [`M ${point.frame * pxPerFrame} ${y(point.value)}`]; const previous = points[index - 1]!; return Array.from({ length: 16 }, (_, step) => { const t = (step + 1) / 16; return `L ${(previous.frame + (point.frame - previous.frame) * t) * pxPerFrame} ${y(previous.value + (point.value - previous.value) * getEasing(previous.easing)(t))}`; }); }).join(' ');
  const selected = selectedKfs.find((item) => sameTarget(item.target, target) && item.prop === prop);
  return <div><svg width={width} height={height} className="block touch-none" onPointerDown={(event) => { if ((event.target as Element).tagName === 'circle') return; onClearSelection(); const frame = Math.max(0, Math.min(dur, Math.round((event.clientX - event.currentTarget.getBoundingClientRect().left) / pxPerFrame))); if (!points.some((point) => point.frame === frame)) setKeyframeValue(target, frame, prop, Math.round(valueAt(event.clientY - event.currentTarget.getBoundingClientRect().top) * 100) / 100); }}><path d={path} fill="none" stroke="oklch(var(--primary))" strokeWidth={1.5} />{points.map((point) => <circle key={point.frame} cx={(drag?.from === point.frame ? drag.frame : point.frame) * pxPerFrame} cy={y(drag?.from === point.frame ? drag.value : point.value)} r={5} className={cn('cursor-grab', isSelectedKeyframe(selectedKfs, target, prop, point.frame) ? 'fill-live' : 'fill-primary')} onPointerDown={(event) => { event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); onSelectKeyframe({ target, prop, frame: point.frame }, event.shiftKey || event.ctrlKey || event.metaKey); setDrag({ from: point.frame, frame: point.frame, value: point.value }); }} onPointerMove={(event) => { if (!drag) return; const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect(); if (!rect) return; setDrag({ from: drag.from, frame: Math.max(0, Math.min(dur, Math.round((event.clientX - rect.left) / pxPerFrame))), value: Math.round(valueAt(event.clientY - rect.top) * 100) / 100 }); }} onPointerUp={() => { if (drag) { if (drag.value !== point.value) setKeyframeValue(target, drag.from, prop, drag.value); if (drag.frame !== drag.from) movePoint(target, prop, drag.from, drag.frame); } setDrag(null); }} onDoubleClick={() => { deletePoint(target, prop, point.frame); onClearSelection(); }} />)}</svg>{selected && <div className="flex items-center gap-2 px-2 py-1.5 text-[12px] text-ink-muted"><span>Keyframe @ {selected.frame}</span><span>easing</span><Select value={points.find((point) => point.frame === selected.frame)?.easing} onChange={(event) => setKeyframeEasing(selected.frame, event.target.value as EasingType)} className="h-7 w-32">{EASINGS.map((easing) => <option key={easing} value={easing}>{easing}</option>)}</Select></div>}</div>;
}

function sampleValue(points: Point[], frame: number): number {
  if (!points.length) return 0;
  if (frame <= points[0]!.frame) return points[0]!.value;
  if (frame >= points[points.length - 1]!.frame) return points[points.length - 1]!.value;
  for (let index = 0; index < points.length - 1; index++) { const start = points[index]!; const end = points[index + 1]!; if (frame >= start.frame && frame <= end.frame) return Math.round((start.value + (end.value - start.value) * getEasing(start.easing)((frame - start.frame) / (end.frame - start.frame || 1))) * 100) / 100; }
  return points[0]!.value;
}
