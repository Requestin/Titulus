import { useEffect, useMemo, useRef, useState } from 'react';
import type { Variable } from '@runtime';
import { Input } from '@/components/ui/form';
import { cn } from '@/lib/cn';

/**
 * Text input for defaultNameForDataElements. Typing `@` opens a dropdown of
 * template variables; selecting one inserts `@variableName`.
 */
export function DefaultNameInput({
  value,
  variables,
  onChange,
  placeholder = 'Гео-@text1',
}: {
  value: string;
  variables: Variable[];
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [atIndex, setAtIndex] = useState<number | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return variables;
    return variables.filter((v) =>
      v.name.toLowerCase().includes(q)
      || v.label.toLowerCase().includes(q)
      || v.id.toLowerCase().includes(q),
    );
  }, [variables, query]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!(e.target instanceof Node)) return;
      if (inputRef.current?.contains(e.target)) return;
      const menu = document.getElementById('default-de-name-menu');
      if (menu?.contains(e.target)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  function insertVariable(name: string) {
    const el = inputRef.current;
    const start = atIndex ?? (el?.selectionStart ?? value.length);
    const end = el?.selectionStart ?? value.length;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const next = `${before}@${name}${after}`;
    onChange(next);
    setOpen(false);
    setQuery('');
    setAtIndex(null);
    requestAnimationFrame(() => {
      const pos = before.length + 1 + name.length;
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  }

  function onInputChange(next: string) {
    onChange(next);
    const el = inputRef.current;
    const caret = el?.selectionStart ?? next.length;
    const before = next.slice(0, caret);
    const match = before.match(/@([A-Za-z_][\w]*)$/);
    if (match) {
      setAtIndex(caret - match[0].length);
      setQuery(match[1] ?? '');
      setOpen(true);
      return;
    }
    if (before.endsWith('@')) {
      setAtIndex(caret - 1);
      setQuery('');
      setOpen(true);
      return;
    }
    setOpen(false);
    setQuery('');
    setAtIndex(null);
  }

  return (
    <div className="relative">
      <Input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        aria-label="Default DE name"
        onChange={(e) => onInputChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            e.preventDefault();
            setOpen(false);
          }
        }}
      />
      {open && (
        <ul
          id="default-de-name-menu"
          role="listbox"
          className="absolute z-20 mt-1 max-h-48 w-full overflow-auto rounded-md border border-border bg-surface p-1 shadow-lg"
        >
          {filtered.length === 0 ? (
            <li className="px-2 py-1.5 text-[12px] text-ink-faint">No variables</li>
          ) : (
            filtered.map((variable) => (
              <li key={variable.id}>
                <button
                  type="button"
                  role="option"
                  className={cn(
                    'flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[12px] hover:bg-surface-2',
                  )}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insertVariable(variable.name)}
                >
                  <span className="truncate font-medium">@{variable.name}</span>
                  <span className="truncate text-[11px] text-ink-faint">{variable.label || variable.type}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
