// frontend/src/editor/panels/TimelinePanel.tsx
//
// Full timeline editor (DEVELOPMENT_PROMPT §6.2 / §8.3): transport + directors,
// a dope sheet of keyframes for every animated target/property in the template, and
// a curve view where keyframes are dragged in both time and value. Playback and
// scrubbing drive the same @runtime renderer the canvas uses (WYSIWYG).

import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Play, Pause, Square, Plus, Trash2, Activity, ListTree } from 'lucide-react';
import { ANIMATABLE_PROPS, getEasing, type AnimatableProp, type EasingType, type Template } from '@runtime';
import { useEditor, type Target } from '../store';
import { Select, NumberInput, Checkbox } from '@/components/ui/form';
import { cn } from '@/lib/cn';

const EASINGS: EasingType[] = ['linear', 'power2.in', 'power2.out', 'power2.inOut', 'bounce.out', 'elastic.out'];
const HEADER_W = 168;
const RULER_H = 24;
const LANE_H = 26;
const GROUP_HDR_H = 20;

interface TimelineTrack {
  target: Target;
  prop: AnimatableProp;
}

interface TrackGroup {
  target: Target;
  label: string;
  tracks: { prop: AnimatableProp }[];
}

function trackKey(target: Target, prop: AnimatableProp): string {
  return `${target.kind}:${target.id}:${prop}`;
}

function targetLabel(template: Template, target: Target): string {
  if (target.kind === 'layer') {
    return template.layers.find((l) => l.id === target.id)?.name ?? target.id;
  }
  return template.groups.find((g) => g.id === target.id)?.name ?? target.id;
}

function collectAllTracks(template: Template): TimelineTrack[] {
  const seen = new Set<string>();
  const tracks: TimelineTrack[] = [];

  for (const k of template.timeline.keyframes) {
    for (const [id, bag] of Object.entries(k.layers)) {
      for (const prop of Object.keys(bag) as AnimatableProp[]) {
        const key = trackKey({ kind: 'layer', id }, prop);
        if (!seen.has(key)) {
          seen.add(key);
          tracks.push({ target: { kind: 'layer', id }, prop });
        }
      }
    }
    for (const [id, bag] of Object.entries(k.groups)) {
      for (const prop of Object.keys(bag) as AnimatableProp[]) {
        const key = trackKey({ kind: 'group', id }, prop);
        if (!seen.has(key)) {
          seen.add(key);
          tracks.push({ target: { kind: 'group', id }, prop });
        }
      }
    }
  }

  return tracks.sort((a, b) => {
    const byName = targetLabel(template, a.target).localeCompare(targetLabel(template, b.target));
    if (byName !== 0) return byName;
    const order = ANIMATABLE_PROPS as readonly AnimatableProp[];
    return order.indexOf(a.prop) - order.indexOf(b.prop);
  });
}

function groupTracksByTarget(template: Template, tracks: TimelineTrack[]): TrackGroup[] {
  const groups: TrackGroup[] = [];
  const map = new Map<string, TrackGroup>();

  for (const track of tracks) {
    const key = `${track.target.kind}:${track.target.id}`;
    let group = map.get(key);
    if (!group) {
      group = { target: track.target, label: targetLabel(template, track.target), tracks: [] };
      map.set(key, group);
      groups.push(group);
    }
    group.tracks.push({ prop: track.prop });
  }
  return groups;
}

interface Point {
  frame: number;
  value: number;
  easing: EasingType;
}

export type SelectedKeyframe = {
  target: Target;
  prop: AnimatableProp;
  frame: number;
};

function isSameKeyframe(a: SelectedKeyframe, target: Target, prop: AnimatableProp, frame: number): boolean {
  return a.target.kind === target.kind && a.target.id === target.id && a.prop === prop && a.frame === frame;
}

export function TimelinePanel() {
  const template = useEditor((s) => s.template);
  const selection = useEditor((s) => s.selection);
  const select = useEditor((s) => s.select);
  const playhead = useEditor((s) => s.playhead);
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

  const [view, setView] = useState<'dope' | 'curve'>('dope');
  const [pxPerFrame, setPxPerFrame] = useState(6);
  const [activeTrack, setActiveTrack] = useState<TimelineTrack | null>(null);
  const [selectedKf, setSelectedKf] = useState<SelectedKeyframe | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const headersScrollRef = useRef<HTMLDivElement>(null);
  const lanesScrollRef = useRef<HTMLDivElement>(null);
  const scrollSyncRef = useRef(false);

  if (!template) return null;
  const dir = template.timeline.directors.find((d) => d.id === activeDirectorId) ?? template.timeline.directors[0];
  const dur = dir?.durationFrames ?? template.timeline.durationFrames;

  const selectedTarget: Target | null = selection ? { kind: selection.kind, id: selection.id } : null;
  const allTracks = collectAllTracks(template);
  const trackGroups = groupTracksByTarget(template, allTracks);

  const selectedTrackedProps: AnimatableProp[] = selectedTarget
    ? ANIMATABLE_PROPS.filter((p) => template.timeline.keyframes.some((k) => {
        const bag = (selectedTarget.kind === 'layer' ? k.layers : k.groups)[selectedTarget.id];
        return bag && bag[p] !== undefined;
      }))
    : [];
  const untrackedProps = ANIMATABLE_PROPS.filter((p) => !selectedTrackedProps.includes(p));

  const activeTrackResolved = activeTrack && allTracks.some((t) => trackKey(t.target, t.prop) === trackKey(activeTrack.target, activeTrack.prop))
    ? activeTrack
    : (selectedTarget
      ? allTracks.find((t) => t.target.kind === selectedTarget.kind && t.target.id === selectedTarget.id) ?? allTracks[0] ?? null
      : allTracks[0] ?? null);

  function openTrack(track: TimelineTrack) {
    select(track.target);
    setActiveTrack(track);
    if (view === 'dope') setView('curve');
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

  function selectKeyframe(kf: SelectedKeyframe) {
    setSelectedKf(kf);
  }

  function handleDeleteKeyframe() {
    if (!selectedKf) return;
    deletePoint(selectedKf.target, selectedKf.prop, selectedKf.frame);
    setSelectedKf(null);
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

  function frameToX(f: number) { return f * pxPerFrame; }
  function xToFrame(x: number) { return Math.max(0, Math.round(x / pxPerFrame)); }

  function scrubFromEvent(e: ReactPointerEvent) {
    const area = lanesScrollRef.current;
    if (!area) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left + area.scrollLeft;
    setPlaying(false);
    setPlayhead(Math.min(dur, xToFrame(x)));
  }

  function laneFrameFromEvent(e: ReactPointerEvent, laneEl: Element): number {
    const area = lanesScrollRef.current;
    const rect = laneEl.getBoundingClientRect();
    const x = e.clientX - rect.left + (area?.scrollLeft ?? 0);
    return Math.min(dur, Math.max(0, Math.round(x / pxPerFrame)));
  }

  const timelineWidth = Math.max(dur * pxPerFrame + 24, 100);

  return (
    <div className="flex h-full flex-col bg-surface">
      {/* Transport + directors */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
        <button
          onClick={() => setPlaying(!playing)}
          className="grid h-7 w-7 place-items-center rounded-md text-ink hover:bg-surface-2"
          title={playing ? 'Pause' : 'Play'}
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
        <button
          onClick={() => { setPlaying(false); setPlayhead(0); }}
          className="grid h-7 w-7 place-items-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink"
          title="Stop"
        >
          <Square className="h-3.5 w-3.5" />
        </button>
        <span className="w-24 text-center text-[12px] tabular-nums text-ink-muted">
          {Math.round(playhead)} / {dur}
        </span>

        <div className="mx-1 h-5 w-px bg-border" />

        <span className="text-[12px] text-ink-muted">Director</span>
        <Select value={dir?.id} onChange={(e) => setActiveDirector(e.target.value)} className="h-7 w-32">
          {template.timeline.directors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </Select>
        <button onClick={addDirector} className="grid h-7 w-7 place-items-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink" title="Add director">
          <Plus className="h-4 w-4" />
        </button>

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

      {/* Director props row */}
      {dir && (
        <div className="flex h-8 shrink-0 items-center gap-3 border-b border-border px-2 text-[12px] text-ink-muted">
          <label className="flex items-center gap-1.5">Dur
            <NumberInput value={dir.durationFrames} onChange={(v) => updateDirector(dir.id, { durationFrames: Math.max(1, Math.round(v)) })} className="h-6 w-16" />
          </label>
          <label className="flex items-center gap-1.5">Offset
            <NumberInput value={dir.offsetFrames} onChange={(v) => updateDirector(dir.id, { offsetFrames: Math.max(0, Math.round(v)) })} className="h-6 w-16" />
          </label>
          <Checkbox label="loop" checked={dir.loop} onChange={(v) => updateDirector(dir.id, { loop: v })} />
          <Checkbox label="swing" checked={dir.swing} onChange={(v) => updateDirector(dir.id, { swing: v })} />
          <Checkbox label="autostart" checked={dir.autostart} onChange={(v) => updateDirector(dir.id, { autostart: v })} />
          {template.timeline.directors.length > 1 && (
            <button onClick={() => removeDirector(dir.id)} className="ml-auto text-ink-faint hover:text-danger" title="Remove director">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}

      {/* Keyframe actions */}
      <div className="flex h-8 shrink-0 items-center border-b border-border px-2">
        <button
          type="button"
          disabled={selectedKf === null}
          onClick={handleDeleteKeyframe}
          title="Delete keyframe"
          className={cn(
            'flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px]',
            selectedKf === null
              ? 'cursor-not-allowed text-ink-faint opacity-40'
              : 'text-ink-muted hover:bg-surface-2 hover:text-danger',
          )}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete keyframe
        </button>
      </div>

      {/* Body: track headers + lanes/curve */}
      <div className="flex min-h-0 flex-1">
        {/* Track headers */}
        <div className="flex shrink-0 flex-col border-r border-border" style={{ width: HEADER_W }}>
          <div
            ref={headersScrollRef}
            className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
            onScroll={() => syncScroll('headers')}
          >
            <div style={{ height: RULER_H }} className="sticky top-0 shrink-0 border-b border-border bg-surface-2" />
            {allTracks.length === 0 ? (
              <p className="p-3 text-[12px] text-ink-faint">
                {selectedTarget ? 'Add a track to start animating.' : 'Select a layer and add a track.'}
              </p>
            ) : (
              trackGroups.map((group) => {
                const groupSelected = selectedTarget?.kind === group.target.kind && selectedTarget.id === group.target.id;
                return (
                  <div key={`${group.target.kind}:${group.target.id}`}>
                    <button
                      type="button"
                      onClick={() => select(group.target)}
                      style={{ height: GROUP_HDR_H }}
                      className={cn(
                        'flex w-full items-center gap-1 px-2 text-left text-[11px] font-semibold',
                        groupSelected ? 'bg-primary/10 text-ink' : 'text-ink-muted hover:bg-surface-2',
                      )}
                      title={group.label}
                    >
                      <span className="truncate">{group.label}</span>
                      <span className="shrink-0 text-[10px] font-normal text-ink-faint">{group.target.kind}</span>
                    </button>
                    {group.tracks.map(({ prop }) => {
                      const track = { target: group.target, prop };
                      const isActive = activeTrackResolved && trackKey(track.target, track.prop) === trackKey(activeTrackResolved.target, activeTrackResolved.prop);
                      return (
                        <div
                          key={prop}
                          style={{ height: LANE_H }}
                          className={cn(
                            'flex items-center gap-0.5 border-b border-border/40 pl-2 pr-1',
                            isActive ? 'bg-primary/15 text-ink' : 'text-ink-muted hover:bg-surface-2',
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => openTrack(track)}
                            className="min-w-0 flex-1 truncate text-left text-[12px] tabular-nums"
                          >
                            {prop}
                          </button>
                          <button
                            type="button"
                            title="Remove track"
                            onClick={() => handleRemoveTrack(track)}
                            className="grid h-6 w-6 shrink-0 place-items-center rounded text-ink-faint hover:bg-surface hover:text-danger"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>
          {selectedTarget && (
            <div className="relative shrink-0 border-t border-border p-1.5">
              <button
                onClick={() => setAddOpen((v) => !v)}
                disabled={untrackedProps.length === 0}
                className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border py-1 text-[12px] text-ink-muted hover:text-ink disabled:opacity-40"
              >
                <Plus className="h-3.5 w-3.5" /> Track
              </button>
              {addOpen && (
                <>
                  <div className="fixed inset-0 z-dropdown" onClick={() => setAddOpen(false)} />
                  <div className="absolute bottom-full left-1.5 z-dropdown mb-1 grid max-h-48 w-28 grid-cols-2 gap-0.5 overflow-auto rounded-md border border-border bg-surface-2 p-1 shadow-xl">
                    {untrackedProps.map((p) => (
                      <button
                        key={p}
                        onClick={() => {
                          const track = { target: selectedTarget, prop: p };
                          addTrackAtPlayhead(selectedTarget, p);
                          setActiveTrack(track);
                          setAddOpen(false);
                        }}
                        className="rounded px-1 py-1 text-left text-[11px] text-ink hover:bg-surface"
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Lanes / curve area */}
        <div
          ref={lanesScrollRef}
          className="relative min-h-0 min-w-0 flex-1 overflow-auto"
          onScroll={() => syncScroll('lanes')}
        >
          <div style={{ width: timelineWidth }} className="relative">
            <Ruler dur={dur} pxPerFrame={pxPerFrame} onScrub={scrubFromEvent} />

            {view === 'dope' && allTracks.length > 0 && (
              <div
                className="pointer-events-none absolute bottom-0 z-sticky w-px bg-live"
                style={{ left: frameToX(playhead), top: RULER_H }}
              >
                <div className="pointer-events-auto absolute -left-1 top-0 h-2 w-2 rounded-sm bg-live" />
              </div>
            )}

            {view === 'dope' && allTracks.length > 0 && (
              <>
                {trackGroups.map((group) => (
                  <div key={`${group.target.kind}:${group.target.id}`}>
                    <div style={{ height: GROUP_HDR_H }} className="border-b border-border/25 bg-surface/50" />
                    {group.tracks.map(({ prop }) => (
                      <DopeLane
                        key={trackKey(group.target, prop)}
                        target={group.target}
                        prop={prop}
                        pxPerFrame={pxPerFrame}
                        dur={dur}
                        frameFromEvent={laneFrameFromEvent}
                        selectedKf={selectedKf}
                        onSelectKeyframe={selectKeyframe}
                        onClearSelection={() => setSelectedKf(null)}
                      />
                    ))}
                  </div>
                ))}
              </>
            )}

            {view === 'curve' && activeTrackResolved && (
              <CurveView
                target={activeTrackResolved.target}
                prop={activeTrackResolved.prop}
                pxPerFrame={pxPerFrame}
                dur={dur}
                frameFromEvent={laneFrameFromEvent}
                selectedKf={selectedKf}
                onSelectKeyframe={selectKeyframe}
                onClearSelection={() => setSelectedKf(null)}
              />
            )}

            {view === 'curve' && !activeTrackResolved && (
              <div className="p-3 text-[12px] text-ink-faint">Add a track to edit its curve.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Ruler({ dur, pxPerFrame, onScrub }: { dur: number; pxPerFrame: number; onScrub: (e: ReactPointerEvent) => void }) {
  const step = pxPerFrame < 4 ? 50 : pxPerFrame < 10 ? 25 : 10;
  const ticks: number[] = [];
  for (let f = 0; f <= dur; f += step) ticks.push(f);
  return (
    <div
      className="sticky left-0 top-0 z-sticky cursor-pointer select-none border-b border-border bg-surface-2"
      style={{ height: RULER_H }}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); onScrub(e); }}
      onPointerMove={(e) => { if (e.buttons === 1) onScrub(e); }}
    >
      {ticks.map((f) => (
        <div key={f} className="absolute top-0 h-full border-l border-border/60 pl-1 text-[10px] tabular-nums text-ink-faint" style={{ left: f * pxPerFrame }}>
          {f}
        </div>
      ))}
    </div>
  );
}

function pointsFor(target: Target, prop: AnimatableProp): Point[] {
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
  target, prop, pxPerFrame, frameFromEvent, selectedKf, onSelectKeyframe, onClearSelection,
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
  const keyframes = useEditor((s) => s.template?.timeline.keyframes);
  const setKeyframeValue = useEditor((s) => s.setKeyframeValue);
  const movePoint = useEditor((s) => s.movePoint);
  const deletePoint = useEditor((s) => s.deletePoint);
  const [drag, setDrag] = useState<{ from: number; cur: number } | null>(null);
  void keyframes;
  const points = pointsFor(target, prop);

  function frameAt(p: Point): number {
    if (drag && drag.from === p.frame) return drag.cur;
    return p.frame;
  }

  function laneClick(e: ReactPointerEvent) {
    if ((e.target as HTMLElement).dataset.kf) return;
    onClearSelection();
    const frame = frameFromEvent(e, e.currentTarget);
    if (points.some((p) => p.frame === frame)) return;
    const v = sampleValue(points, frame);
    setKeyframeValue(target, frame, prop, v);
  }

  return (
    <div className="relative border-b border-border/40" style={{ height: LANE_H }} onPointerDown={laneClick}>
      {points.slice(0, -1).map((a, i) => {
        const b = points[i + 1];
        if (a.value === b.value) return null;
        const x1 = frameAt(a) * pxPerFrame;
        const x2 = frameAt(b) * pxPerFrame;
        const left = Math.min(x1, x2);
        return (
          <div
            key={`${a.frame}-${b.frame}`}
            className="pointer-events-none absolute top-1/2 z-0 h-px -translate-y-1/2 bg-primary/55"
            style={{ left, width: Math.abs(x2 - x1) }}
          />
        );
      })}
      {points.map((p) => {
        const left = frameAt(p) * pxPerFrame;
        const isSelected = selectedKf !== null && isSameKeyframe(selectedKf, target, prop, p.frame);
        return (
          <div
            key={p.frame}
            data-kf="1"
            title={`${prop} @ ${p.frame} = ${p.value}`}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              onSelectKeyframe({ target, prop, frame: p.frame });
              setDrag({ from: p.frame, cur: p.frame });
            }}
            onPointerMove={(e) => {
              if (!drag) return;
              setDrag({ from: drag.from, cur: frameFromEvent(e, e.currentTarget.parentElement as HTMLElement) });
            }}
            onPointerUp={() => {
              if (drag && drag.cur !== drag.from) {
                movePoint(target, prop, drag.from, drag.cur);
                if (selectedKf && isSameKeyframe(selectedKf, target, prop, drag.from)) {
                  onSelectKeyframe({ target, prop, frame: drag.cur });
                }
              }
              setDrag(null);
            }}
            onDoubleClick={(e) => { e.stopPropagation(); deletePoint(target, prop, p.frame); onClearSelection(); }}
            className={cn(
              'absolute top-1/2 z-10 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-grab rounded-[2px] border',
              isSelected ? 'border-live bg-live/85' : 'border-primary bg-primary/70',
            )}
            style={{ left }}
          />
        );
      })}
    </div>
  );
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
  const keyframes = useEditor((s) => s.template?.timeline.keyframes);
  const setKeyframeValue = useEditor((s) => s.setKeyframeValue);
  const movePoint = useEditor((s) => s.movePoint);
  const deletePoint = useEditor((s) => s.deletePoint);
  const setKeyframeEasing = useEditor((s) => s.setKeyframeEasing);
  const [drag, setDrag] = useState<{ from: number; curFrame: number; curValue: number } | null>(null);
  void keyframes;

  const points = pointsFor(target, prop);
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

  // Eased polyline between consecutive points.
  const path: string[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    if (i === 0) { path.push(`M ${a.frame * pxPerFrame} ${yOf(a.value)}`); continue; }
    const prev = points[i - 1];
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
    const rect = e.currentTarget.getBoundingClientRect();
    const frame = frameFromEvent(e, e.currentTarget);
    if (points.some((p) => p.frame === frame)) return;
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
  if (frame <= points[0].frame) return points[0].value;
  if (frame >= points[points.length - 1].frame) return points[points.length - 1].value;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]; const b = points[i + 1];
    if (frame >= a.frame && frame <= b.frame) {
      const tt = (frame - a.frame) / (b.frame - a.frame || 1);
      return Math.round((a.value + (b.value - a.value) * getEasing(a.easing)(tt)) * 100) / 100;
    }
  }
  return points[0].value;
}
