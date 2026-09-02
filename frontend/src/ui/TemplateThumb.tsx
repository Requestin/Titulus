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
  const url = templateThumbnailUrl(
    templateId,
    `${cacheKey ?? ''}${attempt > 0 ? `-retry-${attempt}` : ''}`,
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
    if (attempt >= 3) {
      setFailed(true);
      return;
    }
    retryTimer.current = window.setTimeout(() => {
      setAttempt((value) => value + 1);
    }, [250, 750, 1800][attempt] ?? 1800);
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
