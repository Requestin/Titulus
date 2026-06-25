// frontend/src/editor/panels/TimelinePanel.tsx
//
// Full timeline editor (DEVELOPMENT_PROMPT §6.2 / §8.3): transport + directors,
// a dope sheet of keyframes per animatable property of the selected target, and
// a curve view where keyframes are dragged in both time and value. Playback and
// scrubbing drive the same @runtime renderer the canvas uses (WYSIWYG).

import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Play, Pause, Square, Plus, Trash2, Activity, ListTree } from 'lucide-react';
import { ANIMATABLE_PROPS, getEasing, type AnimatableProp, type EasingType } from '@runtime';
import { useEditor, type Target } from '../store';
import { Select, NumberInput, Checkbox } from '@/components/ui/form';
import { cn } from '@/lib/cn';

const EASINGS: EasingType[] = ['linear', 'power2.in', 'power2.out', 'power2.inOut', 'bounce.out', 'elastic.out'];
const HEADER_W = 132;
const LANE_H = 26;

interface Point {
  frame: number;
  value: number;
  easing: EasingType;
}

export function TimelinePanel() {
  const template = useEditor((s) => s.template);
  const selection = useEditor((s) => s.selection);
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

  const [view, setView] = useState<'dope' | 'curve'>('dope');
  const [pxPerFrame, setPxPerFrame] = useState(6);
  const [curveProp, setCurveProp] = useState<AnimatableProp | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const laneAreaRef = useRef<HTMLDivElement>(null);

  if (!template) return null;
  const dir = template.timeline.directors.find((d) => d.id === activeDirectorId) ?? template.timeline.directors[0];
  const dur = dir?.durationFrames ?? template.timeline.durationFrames;

  const target: Target | null = selection ? { kind: selection.kind, id: selection.id } : null;

  // Props that already have keyframes for this target.
  const trackedProps: AnimatableProp[] = target
    ? ANIMATABLE_PROPS.filter((p) => template.timeline.keyframes.some((k) => {
        const bag = (target.kind === 'layer' ? k.layers : k.groups)[target.id];
        return bag && bag[p] !== undefined;
      }))
    : [];
  const untrackedProps = ANIMATABLE_PROPS.filter((p) => !trackedProps.includes(p));

  function frameToX(f: number) { return f * pxPerFrame; }
  function xToFrame(x: number) { return Math.max(0, Math.round(x / pxPerFrame)); }

  function scrubFromEvent(e: ReactPointerEvent) {
    const area = laneAreaRef.current;
    if (!area) return;
    const rect = area.getBoundingClientRect();
    const x = e.clientX - rect.left + area.scrollLeft;
    setPlaying(false);
    setPlayhead(Math.min(dur, xToFrame(x)));
  }

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

      {/* Body: track headers + lanes/curve */}
      <div className="flex min-h-0 flex-1">
        {/* Track headers */}
        <div className="shrink-0 overflow-y-auto border-r border-border" style={{ width: HEADER_W }}>
          {!target ? (
            <p className="p-3 text-[12px] text-ink-faint">Select a layer to animate.</p>
          ) : (
            <>
              {trackedProps.map((p) => (
                <button
                  key={p}
                  onClick={() => { setCurveProp(p); if (view === 'dope') setView('curve'); }}
                  style={{ height: LANE_H }}
                  className={cn('flex w-full items-center justify-between gap-1 px-2 text-[12px] tabular-nums', curveProp === p ? 'bg-primary/15 text-ink' : 'text-ink-muted hover:bg-surface-2')}
                >
                  <span className="truncate">{p}</span>
                </button>
              ))}
              <div className="relative p-1.5">
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
                    <div className="absolute bottom-9 left-1.5 z-dropdown grid max-h-48 w-28 grid-cols-2 gap-0.5 overflow-auto rounded-md border border-border bg-surface-2 p-1 shadow-xl">
                      {untrackedProps.map((p) => (
                        <button
                          key={p}
                          onClick={() => { addTrackAtPlayhead(target, p); setCurveProp(p); setAddOpen(false); }}
                          className="rounded px-1 py-1 text-left text-[11px] text-ink hover:bg-surface"
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>

        {/* Lanes / curve area */}
        <div ref={laneAreaRef} className="relative min-w-0 flex-1 overflow-x-auto">
          <div style={{ width: Math.max(dur * pxPerFrame + 24, 100) }} className="relative h-full">
            {/* Ruler */}
            <Ruler dur={dur} pxPerFrame={pxPerFrame} onScrub={scrubFromEvent} />

            {/* Playhead */}
            <div
              className="pointer-events-none absolute bottom-0 top-0 z-sticky w-px bg-live"
              style={{ left: frameToX(playhead) }}
            >
              <div className="absolute -left-1 top-0 h-2 w-2 rounded-sm bg-live" />
            </div>

            {target && view === 'dope' && (
              <div className="absolute left-0 right-0 top-6">
                {trackedProps.map((p) => (
                  <DopeLane key={p} target={target} prop={p} pxPerFrame={pxPerFrame} dur={dur} />
                ))}
              </div>
            )}

            {target && view === 'curve' && (() => {
              const cp = curveProp ?? trackedProps[0] ?? null;
              return cp
                ? <CurveView target={target} prop={cp} pxPerFrame={pxPerFrame} dur={dur} />
                : <div className="absolute left-0 top-8 p-3 text-[12px] text-ink-faint">Add a track to edit its curve.</div>;
            })()}
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
      className="sticky left-0 top-0 z-sticky h-6 cursor-pointer select-none border-b border-border bg-surface-2"
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

function DopeLane({ target, prop, pxPerFrame, dur }: { target: Target; prop: AnimatableProp; pxPerFrame: number; dur: number }) {
  const keyframes = useEditor((s) => s.template?.timeline.keyframes);
  const setKeyframeValue = useEditor((s) => s.setKeyframeValue);
  const movePoint = useEditor((s) => s.movePoint);
  const deletePoint = useEditor((s) => s.deletePoint);
  const [drag, setDrag] = useState<{ from: number; cur: number } | null>(null);
  void keyframes;
  const points = pointsFor(target, prop);

  function laneClick(e: ReactPointerEvent) {
    if ((e.target as HTMLElement).dataset.kf) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frame = Math.min(dur, Math.max(0, Math.round((e.clientX - rect.left) / pxPerFrame)));
    if (points.some((p) => p.frame === frame)) return;
    // Insert at lane click: value = interpolate current points or 0.
    const v = sampleValue(points, frame);
    setKeyframeValue(target, frame, prop, v);
  }

  return (
    <div className="relative border-b border-border/40" style={{ height: LANE_H }} onPointerDown={laneClick}>
      {points.map((p) => {
        const left = (drag && drag.from === p.frame ? drag.cur : p.frame) * pxPerFrame;
        return (
          <div
            key={p.frame}
            data-kf="1"
            title={`${prop} @ ${p.frame} = ${p.value}`}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              setDrag({ from: p.frame, cur: p.frame });
            }}
            onPointerMove={(e) => {
              if (!drag) return;
              const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
              setDrag({ from: drag.from, cur: Math.min(dur, Math.max(0, Math.round((e.clientX - rect.left) / pxPerFrame))) });
            }}
            onPointerUp={() => {
              if (drag && drag.cur !== drag.from) movePoint(target, prop, drag.from, drag.cur);
              setDrag(null);
            }}
            onDoubleClick={(e) => { e.stopPropagation(); deletePoint(target, prop, p.frame); }}
            className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-grab rounded-[2px] border border-primary bg-primary/70"
            style={{ left }}
          />
        );
      })}
    </div>
  );
}

function CurveView({ target, prop, pxPerFrame, dur }: { target: Target; prop: AnimatableProp; pxPerFrame: number; dur: number }) {
  const keyframes = useEditor((s) => s.template?.timeline.keyframes);
  const setKeyframeValue = useEditor((s) => s.setKeyframeValue);
  const movePoint = useEditor((s) => s.movePoint);
  const deletePoint = useEditor((s) => s.deletePoint);
  const setKeyframeEasing = useEditor((s) => s.setKeyframeEasing);
  const [drag, setDrag] = useState<{ from: number; curFrame: number; curValue: number } | null>(null);
  const [selFrame, setSelFrame] = useState<number | null>(null);
  void keyframes;

  const points = pointsFor(target, prop);

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
    const rect = e.currentTarget.getBoundingClientRect();
    const frame = Math.min(dur, Math.max(0, Math.round((e.clientX - rect.left) / pxPerFrame)));
    if (points.some((p) => p.frame === frame)) return;
    const value = vOf(e.clientY - rect.top);
    setKeyframeValue(target, frame, prop, Math.round(value * 100) / 100);
  }

  return (
    <div className="absolute left-0 right-0 top-6">
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
                setSelFrame(p.frame);
                setDrag({ from: p.frame, curFrame: p.frame, curValue: p.value });
              }}
              onPointerMove={(e) => {
                if (!drag) return;
                const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                const f = Math.min(dur, Math.max(0, Math.round((e.clientX - rect.left) / pxPerFrame)));
                const v = Math.round(vOf(e.clientY - rect.top) * 100) / 100;
                setDrag({ from: drag.from, curFrame: f, curValue: v });
              }}
              onPointerUp={() => {
                if (drag) {
                  if (drag.curValue !== p.value) setKeyframeValue(target, drag.from, prop, drag.curValue);
                  if (drag.curFrame !== drag.from) movePoint(target, prop, drag.from, drag.curFrame);
                  if (drag.curFrame !== drag.from) setSelFrame(drag.curFrame);
                }
                setDrag(null);
              }}
              onDoubleClick={() => deletePoint(target, prop, p.frame)}
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
          <button onClick={() => { deletePoint(target, prop, selFrame); setSelFrame(null); }} className="ml-auto text-ink-faint hover:text-danger" title="Delete keyframe">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
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
