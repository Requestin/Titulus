import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/cn';
import { toast } from '@/core/toast';
import type { WsStatus } from '@/core/controlWs';
import type { Rundown, TemplateSummary } from '@/core/api';
import { createId } from '@/core/id';

export function WsBadge({ status }: { status: WsStatus }) {
  const dot = status === 'connected' ? 'bg-success' : status === 'connecting' ? 'bg-warning' : 'bg-danger';
  return (
    <span className="flex items-center gap-1.5 text-[12px] text-ink-muted">
      <span className={cn('h-2 w-2 rounded-full', dot)} aria-hidden />
      {status}
    </span>
  );
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to execCommand fallback (non-secure contexts / permission denied).
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function BrowserSourceUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  if (!url) return null;
  return (
    <div className="flex items-center gap-1.5">
      <input
        readOnly
        value={url}
        onFocus={(e) => e.currentTarget.select()}
        className="h-8 w-72 rounded-md border border-border bg-surface-2 px-2 text-[12px] text-ink-muted focus-visible:outline-none"
        title="Browser Source URL for OBS / vMix"
      />
      <button
        type="button"
        onClick={() => {
          void (async () => {
            const ok = await copyTextToClipboard(url);
            if (!ok) {
              toast.error('Failed to copy URL');
              return;
            }
            setCopied(true);
            toast.success('Copied');
            window.setTimeout(() => setCopied(false), 1500);
          })();
        }}
        className="grid h-8 w-8 place-items-center rounded-md border border-border text-ink-muted hover:text-ink"
        title="Copy Browser Source URL"
      >
        {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
}

export function normalizeRundown(rundown: Rundown): Rundown {
  const slots = Array.isArray(rundown.slots) ? rundown.slots : [];
  return {
    ...rundown,
    slots: slots.map((slot, idx) => {
      const vars = slot.vars ?? slot.variables ?? {};
      const name = slot.name ?? slot.label ?? `Slot ${idx + 1}`;
      return {
        ...slot,
        slotId: slot.slotId ?? slot.id ?? createId(),
        name,
        vars,
      };
    }),
  };
}

export function displayOnAirName(id: string, templates: TemplateSummary[], rundowns: Rundown[]): string {
  const tpl = templates.find((t) => t.id === id);
  if (tpl) return tpl.name;
  for (const rundown of rundowns) {
    const slot = rundown.slots.find((s) => s.slotId === id);
    if (slot) return `${rundown.name} / ${slot.name}`;
  }
  return id;
}
