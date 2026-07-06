// frontend/src/editor/media/MediaFileInfo.tsx

import { useEffect, useState } from 'react';
import { api, type MediaAsset } from '@/core/api';

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

  if (type === 'image') {
    return (
      <InfoLines
        lines={[
          asset.displayName,
          `${asset.width}×${asset.height}px`,
          `Alpha: ${asset.hasAlpha ? 'Yes' : 'No'}`,
        ]}
      />
    );
  }

  return (
    <InfoLines
      lines={[
        asset.displayName,
        asset.durationSec != null ? `Duration: ${asset.durationSec.toFixed(2)} sec` : 'Duration: —',
        asset.durationFrames != null ? `Frames: ${asset.durationFrames}` : 'Frames: —',
        `Resolution: ${asset.width}×${asset.height}px`,
        asset.fps != null ? `FPS: ${asset.fps.toFixed(2)}` : 'FPS: —',
        `Alpha: ${asset.hasAlpha ? 'Yes' : 'No'}`,
      ]}
    />
  );
}
