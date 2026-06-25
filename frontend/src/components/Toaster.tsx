import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';
import { useToasts, type ToastKind } from '@/core/toast';
import { cn } from '@/lib/cn';

const ICON = { success: CheckCircle2, error: AlertTriangle, info: Info } as const;
const TONE: Record<ToastKind, string> = {
  success: 'text-success',
  error: 'text-danger',
  info: 'text-info',
};

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);

  return (
    <div
      className="fixed bottom-4 right-4 z-toast flex w-[min(92vw,360px)] flex-col gap-2"
      role="region"
      aria-label="Notifications"
    >
      {toasts.map((t) => {
        const Icon = ICON[t.kind];
        return (
          <div
            key={t.id}
            role="status"
            className="flex items-start gap-2.5 rounded-md border border-border bg-surface-2 px-3 py-2.5 shadow-lg"
          >
            <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', TONE[t.kind])} aria-hidden />
            <p className="flex-1 text-[13px] text-ink">{t.message}</p>
            <button
              onClick={() => dismiss(t.id)}
              className="text-ink-faint transition-colors hover:text-ink"
              aria-label="Dismiss notification"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
