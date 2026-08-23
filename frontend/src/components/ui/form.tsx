import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type PointerEvent,
  type SelectHTMLAttributes,
  type ReactNode,
} from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ChevronsDownUp,
  ChevronsUpDown,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  formatNumber,
  nudgeNumber,
  parseNumberDraft,
  roundForStep,
} from '@/ui/numberInputMath';
import {
  toggleSectionCollapseSignal,
  type SectionCollapseSignal,
} from '@/ui/sectionCollapse';
export type { SectionCollapseSignal } from '@/ui/sectionCollapse';

const BASE_INPUT =
  'h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[13px] text-ink ' +
  'placeholder:text-ink-faint focus-visible:outline-none focus-visible:border-ring ' +
  'disabled:opacity-50';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn(BASE_INPUT, className)} {...props} />;
  },
);

export interface NumberInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'> {
  value: number;
  onChange: (value: number) => void;
  resetValue?: number;
  dragScale?: number;
  stepper?: boolean;
  extraActions?: ReactNode;
}

type NumberDragState = {
  x: number;
  value: number;
  draftValue: number;
  dragging: boolean;
};

export function NumberInput({
  value,
  onChange,
  resetValue,
  dragScale,
  stepper = false,
  extraActions,
  className,
  disabled,
  min,
  max,
  step: stepProp,
  onBlur: onBlurProp,
  onKeyDown: onKeyDownProp,
  ...props
}: NumberInputProps) {
  const [draft, setDraft] = useState(formatNumber(value));
  const dragRef = useRef<NumberDragState | null>(null);
  const parsedStep = finiteAttribute(stepProp);
  const step = parsedStep !== undefined && parsedStep > 0 ? parsedStep : 1;
  const minValue = finiteAttribute(min);
  const maxValue = finiteAttribute(max);
  const scale = dragScale ?? step;
  const accessibleLabel = props['aria-label'] ?? 'value';

  useEffect(() => {
    if (!dragRef.current?.dragging) setDraft(formatNumber(value));
  }, [value]);

  function bounded(next: number) {
    return Math.min(maxValue ?? Number.POSITIVE_INFINITY, Math.max(minValue ?? Number.NEGATIVE_INFINITY, next));
  }

  function isCurrentValue(next: number) {
    const current = bounded(value);
    return next === current || (Number.isNaN(next) && Number.isNaN(current));
  }

  function notifyIfChanged(next: number) {
    if (!isCurrentValue(next)) onChange(next);
  }

  function emit(next: number) {
    if (disabled) {
      setDraft(formatNumber(value));
      return;
    }
    const boundedValue = bounded(next);
    setDraft(formatNumber(boundedValue));
    notifyIfChanged(boundedValue);
  }

  function commit(next: string) {
    setDraft(next);
    const parsed = parseNumberDraft(next);
    if (parsed !== null && !disabled) notifyIfChanged(bounded(parsed));
  }

  function nudge(direction: -1 | 1, shift = false) {
    if (disabled) return;
    emit(nudgeNumber(value, direction, {
      step,
      min: minValue ?? Number.NEGATIVE_INFINITY,
      max: maxValue ?? Number.POSITIVE_INFINITY,
      shift,
    }));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    onKeyDownProp?.(e);
    if (e.defaultPrevented || disabled) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    nudge(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey);
  }

  function onPointerDown(e: PointerEvent<HTMLInputElement>) {
    if (disabled || e.button !== 0) return;
    const startValue = bounded(value);
    dragRef.current = {
      x: e.clientX,
      value: startValue,
      draftValue: startValue,
      dragging: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent<HTMLInputElement>) {
    const drag = dragRef.current;
    if (!drag || disabled) return;
    const dx = e.clientX - drag.x;
    if (!drag.dragging && Math.abs(dx) < 3) return;
    drag.dragging = true;
    e.preventDefault();
    drag.draftValue = bounded(roundForStep(drag.value + dx * scale, scale));
    setDraft(formatNumber(drag.draftValue));
  }

  function releasePointer(e: PointerEvent<HTMLInputElement>) {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    }
  }

  function onPointerUp(e: PointerEvent<HTMLInputElement>) {
    const drag = dragRef.current;
    dragRef.current = null;
    releasePointer(e);
    if (!drag?.dragging) return;
    e.preventDefault();
    if (disabled) setDraft(formatNumber(value));
    else emit(drag.draftValue);
  }

  function onPointerCancel(e: PointerEvent<HTMLInputElement>) {
    const wasDragging = dragRef.current?.dragging ?? false;
    dragRef.current = null;
    releasePointer(e);
    setDraft(formatNumber(value));
    if (wasDragging) e.preventDefault();
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <input
        type="text"
        inputMode="decimal"
        role="spinbutton"
        aria-valuenow={Number.isFinite(value) ? bounded(value) : 0}
        aria-valuemin={minValue}
        aria-valuemax={maxValue}
        {...props}
        disabled={disabled}
        min={min}
        max={max}
        step={stepProp}
        className={cn(BASE_INPUT, 'cursor-ew-resize tabular-nums disabled:cursor-not-allowed', className)}
        value={draft}
        onChange={(e) => commit(e.target.value)}
        onBlur={(e) => {
          const parsed = parseNumberDraft(draft);
          if (parsed === null || disabled) setDraft(formatNumber(value));
          else emit(parsed);
          onBlurProp?.(e);
        }}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      />
      {stepper && (
        <div data-chrome-control className="flex h-8 shrink-0 flex-col justify-center gap-px">
          <button
            type="button"
            aria-label={`Increase ${accessibleLabel}`}
            title={`Increase by ${step}`}
            disabled={disabled || (maxValue !== undefined && value >= maxValue)}
            onClick={(e) => nudge(1, e.shiftKey)}
            className="grid h-3.5 w-3.5 place-items-center rounded-sm text-ink-faint hover:bg-surface hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronUp className="h-3 w-3" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={`Decrease ${accessibleLabel}`}
            title={`Decrease by ${step}`}
            disabled={disabled || (minValue !== undefined && value <= minValue)}
            onClick={(e) => nudge(-1, e.shiftKey)}
            className="grid h-3.5 w-3.5 place-items-center rounded-sm text-ink-faint hover:bg-surface hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronDown className="h-3 w-3" aria-hidden />
          </button>
        </div>
      )}
      {resetValue !== undefined && (
        <button
          type="button"
          data-chrome-control
          aria-label={`Reset ${accessibleLabel}`}
          title="Reset"
          disabled={disabled}
          onClick={() => emit(resetValue)}
          className="grid h-8 w-7 shrink-0 place-items-center rounded-md border border-border bg-surface-2 text-[11px] font-semibold text-ink-muted hover:border-ink-faint hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          R
        </button>
      )}
      {extraActions && (
        <fieldset
          data-chrome-control
          disabled={disabled}
          className="m-0 flex min-w-0 shrink-0 items-center gap-1 border-0 p-0"
        >
          {extraActions}
        </fieldset>
      )}
    </div>
  );
}

function finiteAttribute(value: string | number | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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
const SectionCollapseContext = createContext<SectionCollapseSignal | undefined>(undefined);

export function SectionCollapseProvider({
  signal,
  children,
}: {
  signal: SectionCollapseSignal;
  children: ReactNode;
}) {
  return (
    <SectionCollapseContext.Provider value={signal}>
      {children}
    </SectionCollapseContext.Provider>
  );
}

export function CollapseAllButton({
  signal,
  onChange,
  className,
}: {
  signal: SectionCollapseSignal;
  onChange: (signal: SectionCollapseSignal) => void;
  className?: string;
}) {
  const collapse = signal.open;
  return (
    <button
      type="button"
      data-chrome-control
      className={cn(
        'grid h-7 w-7 place-items-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink',
        className,
      )}
      aria-label={collapse ? 'Collapse all sections' : 'Expand all sections'}
      title={collapse ? 'Collapse all' : 'Expand all'}
      onClick={() => onChange(toggleSectionCollapseSignal(signal))}
    >
      {collapse
        ? <ChevronsDownUp className="h-4 w-4" aria-hidden />
        : <ChevronsUpDown className="h-4 w-4" aria-hidden />}
    </button>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  const signal = useContext(SectionCollapseContext);
  const [open, setOpen] = useState(signal?.open ?? true);
  const contentId = useId();
  const lastSignalVersion = useRef(signal?.version);

  useEffect(() => {
    if (!signal || signal.version === lastSignalVersion.current) return;
    lastSignalVersion.current = signal.version;
    setOpen(signal.open);
  }, [signal]);

  return (
    <div className="border-b border-border px-3 py-3 last:border-b-0">
      <h3 className="mb-2.5 text-[12px] font-semibold text-ink-muted">
        <button
          type="button"
          data-chrome-control
          className="flex w-full items-center gap-1 text-left"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((current) => !current)}
        >
          {open
            ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
            : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />}
          <span>{title}</span>
        </button>
      </h3>
      <div id={contentId} className="space-y-2" hidden={!open}>
        {children}
      </div>
    </div>
  );
}
