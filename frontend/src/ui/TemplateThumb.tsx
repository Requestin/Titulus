import { useEffect, useRef, useState } from 'react';
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
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retryTimer = useRef<number | null>(null);
  // Include a mount-id so the first load is never accidentally cached as 404.
  const mountId = useRef(Math.random().toString(36).slice(2));
  const url = templateThumbnailUrl(
    templateId,
    `${cacheKey ?? mountId.current}${attempt > 0 ? `-r${attempt}` : ''}`,
  );

  useEffect(() => {
    setFailed(false);
    setLoaded(false);
    setAttempt(0);
    if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    return () => {
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    };
  }, [templateId, cacheKey]);

  function retry() {
    if (attempt >= 6) {
      setFailed(true);
      return;
    }
    // First retry is immediate; later retries back off.
    const delays = [0, 200, 500, 1000, 2000, 4000];
    retryTimer.current = window.setTimeout(() => {
      setAttempt((value) => value + 1);
    }, delays[attempt] ?? 4000);
  }

  return (
    <div className={cn('relative grid place-items-center overflow-hidden bg-surface-2 text-ink-faint', className)}>
      {!failed && (
        <img
          key={url}
          src={url}
          alt=""
          className={cn(
            'absolute inset-0 h-full w-full object-cover transition-opacity',
            loaded ? 'opacity-100' : 'opacity-0',
          )}
          onLoad={() => setLoaded(true)}
          onError={retry}
        />
      )}
      {(!loaded || failed) && <LayoutTemplate className={cn('relative', iconClassName)} aria-hidden />}
    </div>
  );
}
