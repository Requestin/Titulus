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

/**
 * Find the maximal chain of connected keyframes containing the segment
 * between a and b. A "chain" is a run of consecutive keyframes where each
 * pair has a line (different values). The chain breaks when two adjacent
 * keyframes have the same value (no line drawn).
 */
function connectedChain(
  points: { frame: number; value: number }[],
  segIndex: number,
): number[] {
  if (points.length === 0) return [];
  // Expand left from segment start
  const frames: number[] = [];
  let left = segIndex;
  while (left >= 0) {
    frames.unshift(points[left]!.frame);
    if (left === 0) break;
    const prev = points[left - 1]!;
    const cur = points[left]!;
    if (prev.value === cur.value) break; // line breaks
    left -= 1;
  }
  // Expand right from segment end
  let right = segIndex + 1;
  while (right < points.length) {
    frames.push(points[right]!.frame);
    if (right === points.length - 1) break;
    const cur = points[right]!;
    const next = points[right + 1]!;
    if (cur.value === next.value) break; // line breaks
    right += 1;
  }
  return frames;
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
}: {
  target: Target;
  prop: AnimatableProp;
  directorId?: string;
  pxPerFrame: number;
  frameFromEvent: (event: ReactPointerEvent, laneEl: Element) => number;
  selected: SelectedKeyframe[];
  onSelect: (keyframe: SelectedKeyframe, mode: 'replace' | 'add' | 'toggle') => void;
  onMoveSelected: (delta: number) => void;
}) {
  const setKeyframeValue = useEditor((state) => state.setKeyframeValue);
  const movePoint = useEditor((state) => state.movePoint);
  const deletePoint = useEditor((state) => state.deletePoint);
  const setSelectedKeyframes = useEditor((state) => state.setSelectedKeyframes);
  const moveSelectedKeyframes = useEditor((state) => state.moveSelectedKeyframes);
  const [drag, setDrag] = useState<{ from: number; cur: number; group: boolean; chain: number[] | null } | null>(null);
  const points = trackPoints(useEditor.getState().template!, target, prop, directorId);

  function frameAt(point: { frame: number }): number {
    if (drag && drag.from === point.frame) return drag.cur;
    if (drag?.group) {
      const delta = drag.cur - drag.from;
      if (drag.chain) {
        // Chain drag: only move keyframes in the chain
        if (drag.chain.includes(point.frame)) return Math.max(0, point.frame + delta);
      } else {
        const hit = selected.find((item) => isSame(item, target, prop, point.frame, directorId));
        if (hit) return Math.max(0, point.frame + delta);
      }
    }
    return point.frame;
  }

  function commitDrag() {
    if (!drag || drag.cur === drag.from) { setDrag(null); return; }
    const delta = drag.cur - drag.from;
    if (drag.chain) {
      // Move all keyframes in the chain by setting selection directly, then moving
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
  }

  return (
    <div
      className="relative border-b border-border/40"
      style={{ height: LANE_H }}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).dataset.kf) return;
        if ((event.target as HTMLElement).dataset.bar) return;
        // Let marquee bubble to the lanes scroller; only insert a keyframe on a click.
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
              setDrag({ from: a.frame, cur: a.frame, group: true, chain });
            }}
            onPointerMove={(event) => {
              if (!drag || !drag.chain) return;
              setDrag({
                ...drag,
                cur: frameFromEvent(event, event.currentTarget.parentElement as HTMLElement),
              });
            }}
            onPointerUp={() => {
              commitDrag();
            }}
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
                // Already selected — keep multi-selection for group drag
                setDrag({ from: point.frame, cur: point.frame, group: true, chain: null });
              } else {
                onSelect(next, mode);
                setDrag({ from: point.frame, cur: point.frame, group: !selectedHere && mode === 'replace' ? true : selectedHere, chain: null });
              }
            }}
            onPointerMove={(event) => {
              if (!drag) return;
              setDrag({
                ...drag,
                cur: frameFromEvent(event, event.currentTarget.parentElement as HTMLElement),
              });
            }}
            onPointerUp={() => {
              commitDrag();
            }}
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
