import { useState, type PointerEvent as ReactPointerEvent } from 'react';
import { getEasing, type AnimatableProp, type EasingType } from '@runtime';
import { Select } from '@/components/ui/form';
import { cn } from '@/lib/cn';
import { useEditor, type Target } from '../store';
import { pointsFor, type SelectedKeyframe } from '../timelineTracks';

const EASINGS: EasingType[] = ['linear', 'power2.in', 'power2.out', 'power2.inOut', 'bounce.out', 'elastic.out'];

export function CurveView({
  target,
  prop,
  pxPerFrame,
  dur,
  frameFromEvent,
  selected,
  onSelect,
}: {
  target: Target;
  prop: AnimatableProp;
  pxPerFrame: number;
  dur: number;
  frameFromEvent: (event: ReactPointerEvent, laneEl: Element) => number;
  selected: SelectedKeyframe[];
  onSelect: (keyframe: SelectedKeyframe) => void;
}) {
  const setKeyframeValue = useEditor((state) => state.setKeyframeValue);
  const commitCurveDrag = useEditor((state) => state.commitCurveDrag);
  const deletePoint = useEditor((state) => state.deletePoint);
  const setKeyframeEasing = useEditor((state) => state.setKeyframeEasing);
  const [drag, setDrag] = useState<{ from: number; curFrame: number; curValue: number } | null>(null);
  const points = pointsFor(useEditor.getState().template!, target, prop);
  const selFrame = selected.find((item) => (
    item.target.kind === target.kind && item.target.id === target.id && item.prop === prop
  ))?.frame ?? null;

  const width = Math.max(dur * pxPerFrame + 24, 100);
  const height = 150;
  const values = points.map((point) => point.value);
  let vMin = Math.min(...values, 0);
  let vMax = Math.max(...values, 1);
  if (vMin === vMax) {
    vMin -= 1;
    vMax += 1;
  }
  const pad = (vMax - vMin) * 0.15 || 1;
  vMin -= pad;
  vMax += pad;
  const yOf = (value: number) => height - ((value - vMin) / (vMax - vMin)) * height;
  const vOf = (y: number) => vMin + (1 - y / height) * (vMax - vMin);

  const path: string[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i]!;
    if (i === 0) {
      path.push(`M ${current.frame * pxPerFrame} ${yOf(current.value)}`);
      continue;
    }
    const prev = points[i - 1]!;
    const ease = getEasing(prev.easing);
    for (let step = 1; step <= 16; step += 1) {
      const t = step / 16;
      const frame = prev.frame + (current.frame - prev.frame) * t;
      const value = prev.value + (current.value - prev.value) * ease(t);
      path.push(`L ${frame * pxPerFrame} ${yOf(value)}`);
    }
  }

  return (
    <div>
      <svg
        width={width}
        height={height}
        className="block touch-none"
        onPointerDown={(event) => {
          if ((event.target as Element).tagName === 'circle') return;
          const rect = event.currentTarget.getBoundingClientRect();
          const frame = frameFromEvent(event, event.currentTarget);
          if (points.some((point) => point.frame === frame)) return;
          setKeyframeValue(target, frame, prop, Math.round(vOf(event.clientY - rect.top) * 100) / 100);
        }}
      >
        <path d={path.join(' ')} fill="none" stroke="oklch(var(--primary))" strokeWidth={1.5} />
        {points.map((point) => {
          const cx = (drag && drag.from === point.frame ? drag.curFrame : point.frame) * pxPerFrame;
          const cy = yOf(drag && drag.from === point.frame ? drag.curValue : point.value);
          return (
            <circle
              key={point.frame}
              cx={cx}
              cy={cy}
              r={5}
              className={cn('cursor-grab', selFrame === point.frame ? 'fill-live' : 'fill-primary')}
              stroke="oklch(var(--ink))"
              strokeWidth={selFrame === point.frame ? 1.5 : 0}
              onPointerDown={(event) => {
                event.stopPropagation();
                (event.currentTarget as SVGCircleElement).setPointerCapture(event.pointerId);
                onSelect({ target, prop, frame: point.frame });
                setDrag({ from: point.frame, curFrame: point.frame, curValue: point.value });
              }}
              onPointerMove={(event) => {
                if (!drag) return;
                const svg = event.currentTarget.ownerSVGElement as SVGSVGElement;
                const rect = svg.getBoundingClientRect();
                setDrag({
                  from: drag.from,
                  curFrame: frameFromEvent(event, svg),
                  curValue: Math.round(vOf(event.clientY - rect.top) * 100) / 100,
                });
              }}
              onPointerUp={() => {
                if (drag) {
                  const moved = drag.curFrame !== drag.from;
                  const changed = drag.curValue !== point.value || moved;
                  if (changed) commitCurveDrag(target, prop, drag.from, drag.curFrame, drag.curValue);
                  if (moved) onSelect({ target, prop, frame: drag.curFrame });
                }
                setDrag(null);
              }}
              onDoubleClick={() => { deletePoint(target, prop, point.frame); }}
            />
          );
        })}
      </svg>
      {selFrame !== null && points.some((point) => point.frame === selFrame) && (
        <div className="flex items-center gap-2 px-2 py-1.5 text-[12px] text-ink-muted">
          <span>Keyframe @ {selFrame}</span>
          <span>easing</span>
          <Select
            value={points.find((point) => point.frame === selFrame)?.easing}
            onChange={(event) => setKeyframeEasing(selFrame, event.target.value as EasingType)}
            className="h-7 w-32"
          >
            {EASINGS.map((easing) => <option key={easing} value={easing}>{easing}</option>)}
          </Select>
        </div>
      )}
    </div>
  );
}
