import { useState, type PointerEvent as ReactPointerEvent } from 'react';
import { getEasing, type AnimatableProp } from '@runtime';
import { cn } from '@/lib/cn';
import { useEditor, type Target } from '../store';
import { pointsFor as trackPoints, type SelectedKeyframe } from '../timelineTracks';
import { LANE_H } from './layout';

function isSame(a: SelectedKeyframe, target: Target, prop: AnimatableProp, frame: number, directorId?: string): boolean {
  return a.target.kind === target.kind && a.target.id === target.id && a.prop === prop && a.frame === frame
    && (a.directorId ?? undefined) === (directorId ?? undefined);
}

function sampleValue(points: { frame: number; value: number; easing: string }[], frame: number): number {
  if (points.length === 0) return 0;
  if (frame <= points[0]!.frame) return points[0]!.value;
  const last = points[points.length - 1]!;
  if (frame >= last.frame) return last.value;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (frame >= a.frame && frame <= b.frame) {
      const t = (frame - a.frame) / (b.frame - a.frame || 1);
      return Math.round((a.value + (b.value - a.value) * getEasing(a.easing as 'linear')(t)) * 100) / 100;
    }
  }
  return points[0]!.value;
}

/** Find the maximal chain of connected keyframes containing segment at segIndex. */
function connectedChain(
  points: { frame: number; value: number }[],
  segIndex: number,
): number[] {
  if (points.length === 0) return [];
  const frames: number[] = [];
  let left = segIndex;
  while (left >= 0) {
    frames.unshift(points[left]!.frame);
    if (left === 0) break;
    if (points[left - 1]!.value === points[left]!.value) break;
    left -= 1;
  }
  let right = segIndex + 1;
  while (right < points.length) {
    frames.push(points[right]!.frame);
    if (right === points.length - 1) break;
    if (points[right]!.value === points[right + 1]!.value) break;
    right += 1;
  }
  return frames;
}

export interface LiveDragState {
  delta: number;
  selected: SelectedKeyframe[];
  chain: { target: Target; prop: AnimatableProp; directorId: string | undefined; frames: number[] } | null;
}

export function DopeLane({
  target,
  prop,
  directorId,
  pxPerFrame,
  frameFromEvent,
  selected,
  onSelect,
  onMoveSelected,
  liveDrag,
  onLiveDragChange,
}: {
  target: Target;
  prop: AnimatableProp;
  directorId?: string;
  pxPerFrame: number;
  frameFromEvent: (event: ReactPointerEvent, laneEl: Element) => number;
  selected: SelectedKeyframe[];
  onSelect: (keyframe: SelectedKeyframe, mode: 'replace' | 'add' | 'toggle') => void;
  onMoveSelected: (delta: number) => void;
  liveDrag: LiveDragState | null;
  onLiveDragChange: (drag: LiveDragState | null) => void;
}) {
  const setKeyframeValue = useEditor((state) => state.setKeyframeValue);
  const movePoint = useEditor((state) => state.movePoint);
  const deletePoint = useEditor((state) => state.deletePoint);
  const setSelectedKeyframes = useEditor((state) => state.setSelectedKeyframes);
  const moveSelectedKeyframes = useEditor((state) => state.moveSelectedKeyframes);
  const [drag, setDrag] = useState<{ from: number; cur: number; group: boolean; chain: number[] | null } | null>(null);
  const points = trackPoints(useEditor.getState().template!, target, prop, directorId);

  // Check if the shared liveDrag affects this lane
  const liveDelta = liveDrag && (liveDrag.chain
    ? (liveDrag.chain.target === target && liveDrag.chain.prop === prop && (liveDrag.chain.directorId ?? undefined) === (directorId ?? undefined))
    : selected.some((item) => isSame(item, target, prop, item.frame, directorId)))
    ? liveDrag.delta
    : 0;

  function frameAt(point: { frame: number }): number {
    // Local drag (this lane is being dragged)
    if (drag?.chain) {
      if (drag.chain.includes(point.frame)) return Math.max(0, point.frame + (drag.cur - drag.from));
      return point.frame;
    }
    if (drag?.group) {
      const delta = drag.cur - drag.from;
      const hit = selected.find((item) => isSame(item, target, prop, point.frame, directorId));
      if (hit) return Math.max(0, point.frame + delta);
    }
    // Shared liveDrag from another lane
    if (liveDelta !== 0 && !drag) {
      if (liveDrag!.chain) {
        if (liveDrag!.chain.frames.includes(point.frame)) return Math.max(0, point.frame + liveDelta);
      } else {
        const hit = selected.find((item) => isSame(item, target, prop, point.frame, directorId));
        if (hit) return Math.max(0, point.frame + liveDelta);
      }
    }
    return point.frame;
  }

  function reportDrag(curDelta: number) {
    if (drag?.chain) {
      onLiveDragChange({
        delta: curDelta,
        selected: [],
        chain: { target, prop, directorId, frames: drag.chain },
      });
    } else {
      onLiveDragChange({
        delta: curDelta,
        selected,
        chain: null,
      });
    }
  }

  function commitDrag() {
    if (!drag || drag.cur === drag.from) { setDrag(null); onLiveDragChange(null); return; }
    const delta = drag.cur - drag.from;
    if (drag.chain) {
      const chainSelection: SelectedKeyframe[] = drag.chain.map((frame) => ({
        target, prop, frame, directorId,
      }));
      setSelectedKeyframes(chainSelection);
      moveSelectedKeyframes(delta);
    } else if (drag.group && selected.length > 1) {
      onMoveSelected(delta);
    } else {
      movePoint(target, prop, drag.from, drag.cur);
      onSelect({ target, prop, frame: drag.cur, directorId }, 'replace');
    }
    setDrag(null);
    onLiveDragChange(null);
  }

  return (
    <div
      className="relative border-b border-border/40"
      style={{ height: LANE_H }}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).dataset.kf) return;
        if ((event.target as HTMLElement).dataset.bar) return;
        if (event.shiftKey || event.ctrlKey || event.metaKey) return;
        const startX = event.clientX;
        const startY = event.clientY;
        const laneEl = event.currentTarget;
        const onUp = (up: PointerEvent) => {
          window.removeEventListener('pointerup', onUp);
          if (Math.hypot(up.clientX - startX, up.clientY - startY) > 4) return;
          const fake = { clientX: up.clientX } as unknown as ReactPointerEvent;
          const f = frameFromEvent(fake, laneEl);
          if (points.some((point) => point.frame === f)) return;
          setKeyframeValue(target, f, prop, sampleValue(points, f));
        };
        window.addEventListener('pointerup', onUp);
      }}
    >
      {points.slice(0, -1).map((a, index) => {
        const b = points[index + 1]!;
        if (a.value === b.value) return null;
        const x1 = frameAt(a) * pxPerFrame;
        const x2 = frameAt(b) * pxPerFrame;
        return (
          <div
            key={`${a.frame}-${b.frame}`}
            data-bar="1"
            className="absolute top-1/2 z-0 h-1.5 -translate-y-1/2 cursor-ew-resize rounded-full bg-primary/40 hover:bg-primary/60"
            style={{ left: Math.min(x1, x2), width: Math.abs(x2 - x1) }}
            onPointerDown={(event) => {
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              const chain = connectedChain(points, index);
              // Grab frame under the pointer — delta is relative to this point,
              // not the left keyframe (avoids jumping the chain on mousedown).
              const grabFrame = frameFromEvent(event, event.currentTarget.parentElement as HTMLElement);
              setDrag({ from: grabFrame, cur: grabFrame, group: true, chain });
            }}
            onPointerMove={(event) => {
              if (!drag || !drag.chain) return;
              const cur = frameFromEvent(event, event.currentTarget.parentElement as HTMLElement);
              setDrag({ ...drag, cur });
              reportDrag(cur - drag.from);
            }}
            onPointerUp={() => { commitDrag(); }}
          />
        );
      })}
      {points.map((point) => {
        const selectedHere = selected.some((item) => isSame(item, target, prop, point.frame, directorId));
        return (
          <div
            key={point.frame}
            data-kf="1"
            title={`${prop} @ ${point.frame} = ${point.value}`}
            onPointerDown={(event) => {
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              const mode = event.shiftKey || event.ctrlKey || event.metaKey ? 'toggle' : 'replace';
              const next = { target, prop, frame: point.frame, directorId };
              if (selectedHere && mode === 'replace') {
                setDrag({ from: point.frame, cur: point.frame, group: true, chain: null });
              } else {
                onSelect(next, mode);
                setDrag({ from: point.frame, cur: point.frame, group: true, chain: null });
              }
            }}
            onPointerMove={(event) => {
              if (!drag) return;
              const cur = frameFromEvent(event, event.currentTarget.parentElement as HTMLElement);
              setDrag({ ...drag, cur });
              reportDrag(cur - drag.from);
            }}
            onPointerUp={() => { commitDrag(); }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              deletePoint(target, prop, point.frame);
            }}
            className={cn(
              'absolute top-1/2 z-10 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-grab rounded-[2px] border',
              selectedHere ? 'border-live bg-live/85' : 'border-primary bg-primary/70',
            )}
            style={{ left: frameAt(point) * pxPerFrame }}
          />
        );
      })}
    </div>
  );
}
