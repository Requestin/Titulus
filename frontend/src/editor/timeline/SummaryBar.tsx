import { useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Target } from '../store';

export function SummaryBar({
  target,
  start,
  end,
  pxPerFrame,
  onMove,
  onStretch,
}: {
  target: Target;
  start: number;
  end: number;
  pxPerFrame: number;
  onMove: (target: Target, delta: number) => void;
  onStretch: (target: Target, edge: 'start' | 'end', frame: number) => void;
}) {
  const [preview, setPreview] = useState<{ start: number; end: number } | null>(null);
  const shownStart = preview?.start ?? start;
  const shownEnd = preview?.end ?? end;
  const left = shownStart * pxPerFrame;
  const width = Math.max((shownEnd - shownStart) * pxPerFrame, 8);

  function begin(event: ReactPointerEvent<HTMLDivElement>) {
    event.stopPropagation();
    const handle = (event.target as HTMLElement).dataset.edge as 'start' | 'end' | undefined;
    const originX = event.clientX;
    event.currentTarget.setPointerCapture(event.pointerId);
    const onMovePtr = (move: PointerEvent) => {
      const delta = Math.round((move.clientX - originX) / pxPerFrame);
      if (handle === 'start') setPreview({ start: Math.max(0, start + delta), end });
      else if (handle === 'end') setPreview({ start, end: Math.max(start, end + delta) });
      else setPreview({ start: Math.max(0, start + delta), end: Math.max(0, end + delta) });
    };
    const onUp = (up: PointerEvent) => {
      const delta = Math.round((up.clientX - originX) / pxPerFrame);
      setPreview(null);
      if (handle) onStretch(target, handle, handle === 'start' ? start + delta : end + delta);
      else if (delta !== 0) onMove(target, delta);
      window.removeEventListener('pointermove', onMovePtr);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMovePtr);
    window.addEventListener('pointerup', onUp);
  }

  return (
    <div
      className="absolute top-1/2 h-2 -translate-y-1/2 cursor-grab rounded-sm bg-primary/35"
      style={{ left, width }}
      data-summary="1"
      onPointerDown={begin}
    >
      <span data-edge="start" className="absolute left-0 top-1/2 h-3 w-1.5 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-sm bg-primary" />
      <span data-edge="end" className="absolute right-0 top-1/2 h-3 w-1.5 translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-sm bg-primary" />
    </div>
  );
}
