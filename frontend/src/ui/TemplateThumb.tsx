import { useEffect, useState } from 'react';
import { LayoutTemplate } from 'lucide-react';
import { cn } from '@/lib/cn';
import { templateThumbnailUrl } from '@/editor/captureThumbnail';

/** Compact template preview: shows JPEG when present, otherwise a placeholder icon. */
export function TemplateThumb({
  templateId,
  cacheKey,
  className,
  iconClassName = 'h-4 w-4',
}: {
  templateId: string;
  cacheKey?: string;
  className?: string;
  iconClassName?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const baseUrl = templateThumbnailUrl(templateId, cacheKey);

  useEffect(() => {
    let cancelled = false;
    let attempt = 0;
    let timer: number | null = null;
    setSrc(null);

    const delays = [0, 150, 400, 900, 1800, 3500];

    function tryLoad() {
      const url = attempt === 0
        ? baseUrl
        : `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}r=${attempt}`;
      const image = new Image();
      image.onload = () => {
        if (cancelled) return;
        setSrc(url);
      };
      image.onerror = () => {
        if (cancelled) return;
        attempt += 1;
        if (attempt >= delays.length) return;
        timer = window.setTimeout(tryLoad, delays[attempt] ?? 3500);
      };
      image.src = url;
    }

    tryLoad();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [templateId, cacheKey, baseUrl]);

  return (
    <div className={cn('relative grid place-items-center overflow-hidden bg-surface-2 text-ink-faint', className)}>
      {src ? (
        <img
          src={src}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <LayoutTemplate className={cn('relative', iconClassName)} aria-hidden />
      )}
    </div>
  );
}
