import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes, type ReactNode } from 'react';
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

export interface NumberInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'> {
  value: number;
  onChange: (value: number) => void;
}

export function NumberInput({ value, onChange, className, ...props }: NumberInputProps) {
  return (
    <input
      type="number"
      className={cn(BASE_INPUT, 'tabular-nums', className)}
      value={Number.isFinite(value) ? value : 0}
      onChange={(e) => {
        const n = parseFloat(e.target.value);
        onChange(Number.isFinite(n) ? n : 0);
      }}
      {...props}
    />
  );
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
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-b border-border px-3 py-3 last:border-b-0">
      <h3 className="mb-2.5 text-[12px] font-semibold text-ink-muted">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}
