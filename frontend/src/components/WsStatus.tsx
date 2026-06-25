import { useEffect } from 'react';
import { useControlWs, type WsStatus as WsStatusKind } from '@/core/controlWs';
import { cn } from '@/lib/cn';

const LABEL: Record<WsStatusKind, string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  disconnected: 'Offline',
};

const DOT: Record<WsStatusKind, string> = {
  connected: 'bg-success',
  connecting: 'bg-warning',
  disconnected: 'bg-danger',
};

export function WsStatus() {
  const status = useControlWs((s) => s.status);
  const connect = useControlWs((s) => s.connect);

  useEffect(() => {
    connect();
  }, [connect]);

  return (
    <div
      className="flex items-center gap-2 text-[13px] text-ink-muted"
      title={`Control WebSocket: ${LABEL[status]}`}
    >
      <span className={cn('h-2 w-2 rounded-full', DOT[status])} aria-hidden />
      <span className="tabular-nums">{LABEL[status]}</span>
    </div>
  );
}
