import {
  forwardRef,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type PointerEvent,
  type SelectHTMLAttributes,
  type ReactNode,
} from 'react';
import { ChevronDown, ChevronUp, ChevronRight, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
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
  const min = props.min !== undefined && props.min !== null && props.min !== ''
    ? Number(props.min)
    : undefined;
  const max = props.max !== undefined && props.max !== null && props.max !== ''
    ? Number(props.max)
    : undefined;

  function clamp(n: number): number {
    let out = n;
    if (typeof min === 'number' && Number.isFinite(min)) out = Math.max(min, out);
    if (typeof max === 'number' && Number.isFinite(max)) out = Math.min(max, out);
    return out;
  }

  function emit(n: number) {
    const next = clamp(n);
    setDraft(formatNumber(next));
    onChange(next);
  }

  useEffect(() => {
    if (!dragRef.current?.dragging) setDraft(formatNumber(value));
  }, [value]);

  function commit(next: string) {
    setDraft(next);
    if (next === '' || next === '-' || next === '.' || next === '-.') return;
    const n = Number.parseFloat(next);
    if (Number.isFinite(n)) emit(n);
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
    const rounded = clamp(roundForStep(drag.value + dx * scale, scale));
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
    if (wasDragging) {
      e.preventDefault();
      setDraft(formatNumber(clamp(value)));
    }
  }

  function nudgeBy(delta: number) {
    emit(roundForStep(value + delta, nudge));
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
        onBlur={() => {
          const n = Number.parseFloat(draft);
          if (Number.isFinite(n)) emit(n);
          else setDraft(formatNumber(value));
        }}
        onPointerDown={props.disabled ? undefined : onPointerDown}
        onPointerMove={props.disabled ? undefined : onPointerMove}
        onPointerUp={props.disabled ? undefined : onPointerUp}
        onPointerCancel={props.disabled ? undefined : onPointerUp}
      />
      <div className="flex h-8 shrink-0 flex-col justify-center gap-px">
        <button
          type="button"
          title={`Increase by ${nudge}`}
          disabled={props.disabled || (typeof max === 'number' && value >= max)}
          onClick={() => nudgeBy(nudge)}
          className={cn(stepperBtn, 'h-3.5')}
        >
          <ChevronUp className="h-3 w-3" aria-hidden />
        </button>
        <button
          type="button"
          title={`Decrease by ${nudge}`}
          disabled={props.disabled || (typeof min === 'number' && value <= min)}
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
          disabled={props.disabled}
          onClick={() => emit(resetValue)}
          className="grid h-8 w-7 shrink-0 place-items-center rounded-md border border-border bg-surface-2 text-[11px] font-semibold text-ink-muted hover:border-ink-faint hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          R
        </button>
      )}
      {extraActions?.map((action) => (
        <button
          key={action.label}
          type="button"
          title={action.title ?? action.label}
          disabled={props.disabled}
          onClick={action.onClick}
          className="grid h-8 shrink-0 place-items-center rounded-md border border-border bg-surface-2 px-1 text-[10px] font-semibold tabular-nums text-ink-muted hover:border-ink-faint hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
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

export function ColorInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-1.5',
        disabled && 'opacity-50',
      )}
    >
      <input
        type="color"
        aria-label="Color"
        disabled={disabled}
        className="h-5 w-5 cursor-pointer rounded border-0 bg-transparent p-0 disabled:cursor-not-allowed"
        value={normalizeHex(value)}
        onChange={(e) => onChange(e.target.value)}
      />
      <input
        className="min-w-0 flex-1 bg-transparent text-[12px] tabular-nums text-ink focus-visible:outline-none disabled:cursor-not-allowed"
        value={value}
        disabled={disabled}
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
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className={cn(
      'flex select-none items-center gap-2 text-[13px] text-ink',
      disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
    )}
    >
      <input
        type="checkbox"
        className="h-3.5 w-3.5 accent-[oklch(var(--primary))]"
        checked={checked}
        disabled={disabled}
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

/** Bump `version` to force every listening Section to `open`. */
export type SectionCollapseSignal = { version: number; open: boolean };

const SectionCollapseCtx = createContext<SectionCollapseSignal | undefined>(undefined);

/** Provides expand/collapse-all signal to nested `Section` components. */
export function SectionCollapseProvider({
  signal,
  children,
}: {
  signal: SectionCollapseSignal;
  children: ReactNode;
}) {
  return (
    <SectionCollapseCtx.Provider value={signal}>
      {children}
    </SectionCollapseCtx.Provider>
  );
}

/** Toolbar control: collapse / expand all panel sections. */
export function CollapseAllButton({
  signal,
  onChange,
  className,
}: {
  signal: SectionCollapseSignal;
  onChange: (next: SectionCollapseSignal) => void;
  className?: string;
}) {
  const collapsing = signal.open;
  return (
    <button
      type="button"
      title={collapsing ? 'Collapse all' : 'Expand all'}
      aria-label={collapsing ? 'Collapse all sections' : 'Expand all sections'}
      className={cn(
        'grid h-7 w-7 place-items-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink',
        className,
      )}
      onClick={() => onChange({ version: signal.version + 1, open: !signal.open })}
    >
      {collapsing
        ? <ChevronsDownUp className="h-4 w-4" aria-hidden />
        : <ChevronsUpDown className="h-4 w-4" aria-hidden />}
    </button>
  );
}

/** A panel section with a heading; optionally collapsible. */
export function Section({
  title,
  children,
  collapsible = true,
  defaultOpen = true,
  collapseSignal: collapseSignalProp,
}: {
  title: string;
  children: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  /** When `version` changes, force this section open/closed. */
  collapseSignal?: SectionCollapseSignal;
}) {
  const ctxSignal = useContext(SectionCollapseCtx);
  const collapseSignal = collapseSignalProp ?? ctxSignal;
  const [open, setOpen] = useState(defaultOpen);
  const lastVersion = useRef(collapseSignal?.version);

  useEffect(() => {
    if (!collapseSignal) return;
    if (lastVersion.current === collapseSignal.version) return;
    lastVersion.current = collapseSignal.version;
    setOpen(collapseSignal.open);
  }, [collapseSignal]);

  if (!collapsible) {
    return (
      <div className="border-b border-border px-3 py-3 last:border-b-0">
        <h3 className="mb-2.5 text-[12px] font-semibold text-ink-muted">{title}</h3>
        <div className="space-y-2">{children}</div>
      </div>
    );
  }
  return (
    <div className="border-b border-border px-3 py-3 last:border-b-0">
      <button
        type="button"
        className="mb-2.5 flex w-full items-center gap-1 text-left"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open
          ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
          : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />}
        <h3 className="text-[12px] font-semibold text-ink-muted">{title}</h3>
      </button>
      {open ? <div className="space-y-2">{children}</div> : null}
    </div>
  );
}
