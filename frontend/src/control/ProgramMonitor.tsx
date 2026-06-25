// frontend/src/control/ProgramMonitor.tsx
//
// Live program monitor: embeds the channel page (the real browser renderer) for
// the selected channel. channel.html renders at native 1920x1080 (1:1, same as
// OBS browser source), so we render the iframe at that size and CSS-scale it to
// fit the monitor box. A checkerboard behind reveals transparency.

import { useEffect, useRef, useState } from 'react';

const CANVAS_W = 1920;
const CANVAS_H = 1080;

export function ProgramMonitor({ channelId }: { channelId: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.2);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setScale(el.clientWidth / CANVAS_W);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-semibold text-ink-muted">Program</span>
        <span className="rounded bg-live px-1.5 py-0.5 text-[11px] font-semibold text-primary-ink">ON AIR</span>
      </div>
      <div
        ref={wrapRef}
        className="relative aspect-video w-full overflow-hidden rounded-lg border border-border"
        style={{
          backgroundColor: 'oklch(0.26 0.01 274)',
          backgroundImage:
            'linear-gradient(45deg, oklch(0.21 0.01 274) 25%, transparent 25%), linear-gradient(-45deg, oklch(0.21 0.01 274) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, oklch(0.21 0.01 274) 75%), linear-gradient(-45deg, transparent 75%, oklch(0.21 0.01 274) 75%)',
          backgroundSize: '24px 24px',
          backgroundPosition: '0 0, 0 12px, 12px -12px, -12px 0',
        }}
      >
        <iframe
          key={channelId}
          title="Program monitor"
          src={`/channel.html?channel=${encodeURIComponent(channelId)}&preview=1`}
          className="absolute left-0 top-0 border-0"
          style={{
            width: CANVAS_W,
            height: CANVAS_H,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
            backgroundColor: 'transparent',
          }}
        />
      </div>
    </div>
  );
}
