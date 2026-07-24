// frontend/src/editor/media/MediaFileInfo.tsx

import { useEffect, useState } from 'react';
import { api, type MediaAsset } from '@/core/api';
import { toast } from '@/core/toast';
import { copyTextToClipboard } from '@/control/controlShared';

function InfoLines({ lines }: { lines: string[] }) {
  return (
    <div className="mt-2 space-y-0.5 text-[11px] leading-relaxed text-ink-faint">
      {lines.map((line) => (
        <div key={line}>{line}</div>
      ))}
    </div>
  );
}

export function MediaFileInfo({ url, type }: { url: string; type: 'image' | 'video' }) {
  const [asset, setAsset] = useState<MediaAsset | null>(null);

  useEffect(() => {
    if (!url) {
      setAsset(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const a = await api.media.lookup(url);
        if (!cancelled) setAsset(a);
      } catch {
        if (!cancelled) setAsset(null);
      }
    })();
    return () => { cancelled = true; };
  }, [url]);

  if (!asset) return null;

  const token = `asset:${asset.id}`;
  const meta = type === 'image'
    ? [
      asset.displayName,
      `${asset.width}×${asset.height}px`,
      `Alpha: ${asset.hasAlpha ? 'Yes' : 'No'}`,
    ]
    : [
      asset.displayName,
      asset.durationSec != null ? `Duration: ${asset.durationSec.toFixed(2)} sec` : 'Duration: —',
      asset.durationFrames != null ? `Frames: ${asset.durationFrames}` : 'Frames: —',
      `Resolution: ${asset.width}×${asset.height}px`,
      asset.fps != null ? `FPS: ${asset.fps.toFixed(2)}` : 'FPS: —',
      `Alpha: ${asset.hasAlpha ? 'Yes' : 'No'}`,
    ];

  return (
    <div>
      <InfoLines lines={meta} />
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-faint">
        <code className="max-w-[14rem] truncate rounded bg-surface-2 px-1 py-0.5 font-mono text-[10px] text-ink-muted">
          {token}
        </code>
        <button
          type="button"
          className="rounded border border-border px-1.5 py-0.5 text-[10px] hover:bg-surface-2 hover:text-ink"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void (async () => {
              const ok = await copyTextToClipboard(token);
              if (!ok) {
                toast.error('Failed to copy token');
                return;
              }
              toast.success('token copied');
            })();
          }}
        >
          Copy
        </button>
      </div>
    </div>
  );
}
