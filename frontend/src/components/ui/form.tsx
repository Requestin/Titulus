import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type PointerEvent,
  type SelectHTMLAttributes,
  type ReactNode,
} from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/cn';

const BASE_INPUT =
  'h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[13px] text-ink ' +
  'placeholder:text-ink-faint focus-visible:outline-none focus-visible:border-ring ' +
  'disabled:opacity-50';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn(BASE_INPUT, className)} {...props} />;
  },
);

export interface NumberInputExtraAction {
  label: string;
  title?: string;
  onClick: () => void;
}

export interface NumberInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'> {
  value: number;
  onChange: (value: number) => void;
  resetValue?: number;
  dragScale?: number;
  stepperStep?: number;
  extraActions?: NumberInputExtraAction[];
}

export function NumberInput({
  value,
  onChange,
  resetValue,
  dragScale,
  stepperStep,
  extraActions,
  className,
  ...props
}: NumberInputProps) {
  const [draft, setDraft] = useState(formatNumber(value));
  const dragRef = useRef<{ x: number; value: number; dragging: boolean } | null>(null);
  const step = typeof props.step === 'number' ? props.step : Number.parseFloat(String(props.step ?? 1));
  const scale = dragScale ?? (Number.isFinite(step) ? step : 1);
  const nudge = stepperStep ?? 1;

  useEffect(() => {
    if (!dragRef.current?.dragging) setDraft(formatNumber(value));
  }, [value]);

  function commit(next: string) {
    setDraft(next);
    if (next === '' || next === '-' || next === '.' || next === '-.') return;
    const n = Number.parseFloat(next);
    if (Number.isFinite(n)) onChange(n);
  }

  function onPointerDown(e: PointerEvent<HTMLInputElement>) {
    if (e.button !== 0) return;
    dragRef.current = { x: e.clientX, value, dragging: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent<HTMLInputElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (!drag.dragging && Math.abs(dx) < 3) return;
    drag.dragging = true;
    e.preventDefault();
    const rounded = roundForStep(drag.value + dx * scale, scale);
    setDraft(formatNumber(rounded));
    onChange(rounded);
  }

  function onPointerUp(e: PointerEvent<HTMLInputElement>) {
    const drag = dragRef.current;
    const wasDragging = drag?.dragging ?? false;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    }
    if (wasDragging) e.preventDefault();
  }

  function nudgeBy(delta: number) {
    const next = roundForStep(value + delta, nudge);
    setDraft(formatNumber(next));
    onChange(next);
  }

  const stepperBtn =
    'grid w-3.5 place-items-center rounded-sm text-ink-faint hover:bg-surface hover:text-ink disabled:opacity-40';

  return (
    <div className="flex min-w-0 items-center gap-1">
      <input
        type="text"
        inputMode="decimal"
        {...props}
        className={cn(BASE_INPUT, 'min-w-0 flex-1 cursor-ew-resize tabular-nums', className)}
        value={draft}
        onChange={(e) => commit(e.target.value)}
        onBlur={() => setDraft(formatNumber(value))}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <div className="flex h-8 shrink-0 flex-col justify-center gap-px">
        <button
          type="button"
          title={`Increase by ${nudge}`}
          onClick={() => nudgeBy(nudge)}
          className={cn(stepperBtn, 'h-3.5')}
        >
          <ChevronUp className="h-3 w-3" aria-hidden />
        </button>
        <button
          type="button"
          title={`Decrease by ${nudge}`}
          onClick={() => nudgeBy(-nudge)}
          className={cn(stepperBtn, 'h-3.5')}
        >
          <ChevronDown className="h-3 w-3" aria-hidden />
        </button>
      </div>
      {resetValue !== undefined && (
        <button
          type="button"
          title="Reset"
          onClick={() => onChange(resetValue)}
          className="grid h-8 w-7 shrink-0 place-items-center rounded-md border border-border bg-surface-2 text-[11px] font-semibold text-ink-muted hover:border-ink-faint hover:text-ink"
        >
          R
        </button>
      )}
      {extraActions?.map((action) => (
        <button
          key={action.label}
          type="button"
          title={action.title ?? action.label}
          onClick={action.onClick}
          className="grid h-8 shrink-0 place-items-center rounded-md border border-border bg-surface-2 px-1 text-[10px] font-semibold tabular-nums text-ink-muted hover:border-ink-faint hover:text-ink"
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : '0';
}

function roundForStep(value: number, step: number): number {
  if (!Number.isFinite(step) || step >= 1) return Math.round(value);
  const decimals = Math.min(6, Math.max(0, String(step).split('.')[1]?.length ?? 0));
  return Number(value.toFixed(decimals));
}

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <select
        ref={ref}
        className={cn(BASE_INPUT, 'cursor-pointer appearance-none pr-6', className)}
        {...props}
      >
        {children}
      </select>
    );
  },
);

export function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-1.5">
      <input
        type="color"
        aria-label="Color"
        className="h-5 w-5 cursor-pointer rounded border-0 bg-transparent p-0"
        value={normalizeHex(value)}
        onChange={(e) => onChange(e.target.value)}
      />
      <input
        className="min-w-0 flex-1 bg-transparent text-[12px] tabular-nums text-ink focus-visible:outline-none"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
    </div>
  );
}

function normalizeHex(v: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v : '#000000';
}

export function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer select-none items-center gap-2 text-[13px] text-ink">
      <input
        type="checkbox"
        className="h-3.5 w-3.5 accent-[oklch(var(--primary))]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

/** A labeled control row for property panels (wider inputs, expand 20px left). */
export function PropertyField({ label, children, htmlFor }: { label: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="grid grid-cols-[68px_minmax(0,1fr)] items-center gap-2">
      <label htmlFor={htmlFor} className="truncate text-[12px] text-ink-muted">
        {label}
      </label>
      <div className="min-w-0 -ml-5 w-[calc(100%+20px)]">{children}</div>
    </div>
  );
}

/** A labeled control row for property panels. */
export function Field({ label, children, htmlFor }: { label: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="grid grid-cols-[88px_1fr] items-center gap-2">
      <label htmlFor={htmlFor} className="truncate text-[12px] text-ink-muted">
        {label}
      </label>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** A panel section with a heading. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-b border-border px-3 py-3 last:border-b-0">
      <h3 className="mb-2.5 text-[12px] font-semibold text-ink-muted">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}
