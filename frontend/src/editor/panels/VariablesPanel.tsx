// frontend/src/editor/panels/VariablesPanel.tsx
//
// CRUD for template variables. image/video defaults can be uploaded (transcoded
// to VP9/WebM alpha for video). Bind layer fields to these in Properties.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Plus, Trash2, Upload, Loader2, Pencil, ChevronDown, ChevronRight } from 'lucide-react';
import type { Variable, VariableType } from '@runtime';
import { useEditor } from '../store';
import { useUpload } from '../useUpload';
import {
  Input, NumberInput, Select, ColorInput,
  CollapseAllButton,
  type SectionCollapseSignal,
} from '@/components/ui/form';
import { cn } from '@/lib/cn';

const TYPES: VariableType[] = ['text', 'multitext', 'textfile', 'number', 'time', 'color', 'image', 'video'];

export function VariablesPanel() {
  const template = useEditor((s) => s.template);
  const addVariable = useEditor((s) => s.addVariable);
  const [collapseSignal, setCollapseSignal] = useState<SectionCollapseSignal>({ version: 0, open: true });
  if (!template) return null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-[12px] font-semibold text-ink-muted">Variables</span>
        <div className="flex items-center gap-0.5">
          <CollapseAllButton signal={collapseSignal} onChange={setCollapseSignal} />
          <button
            onClick={addVariable}
            title="Add variable"
            className="grid h-7 w-7 place-items-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            <Plus className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {template.variables.length === 0 && (
          <p className="py-6 text-center text-[12px] text-ink-faint">
            No variables. Add one, then bind a layer field to it.
          </p>
        )}
        {template.variables.map((v) => (
          <VariableRow key={v.id} v={v} collapseSignal={collapseSignal} />
        ))}
      </div>
    </div>
  );
}

function StackedField({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <span className="block text-[12px] font-medium text-ink-muted" title={hint}>
        {label}
      </span>
      {children}
    </div>
  );
}

function VariableRow({
  v,
  collapseSignal,
}: {
  v: Variable;
  collapseSignal: SectionCollapseSignal;
}) {
  const updateVariable = useEditor((s) => s.updateVariable);
  const removeVariable = useEditor((s) => s.removeVariable);
  const [idEditing, setIdEditing] = useState(false);
  const idInputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(true);
  const lastVersion = useRef(collapseSignal.version);

  useEffect(() => {
    if (idEditing) idInputRef.current?.focus();
  }, [idEditing]);

  useEffect(() => {
    if (lastVersion.current === collapseSignal.version) return;
    lastVersion.current = collapseSignal.version;
    setOpen(collapseSignal.open);
  }, [collapseSignal]);

  const title = v.label || v.name || 'variable';

  return (
    <div className="rounded-md border border-border bg-surface">
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open
            ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
            : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />}
          <span className="truncate text-[12px] font-semibold text-ink">{title}</span>
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-ink-faint">{v.type}</span>
        </button>
        <button
          onClick={() => removeVariable(v.id)}
          title="Delete variable"
          className="grid h-7 w-7 place-items-center rounded-md text-ink-faint hover:text-danger"
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {open && (
        <div className="space-y-3 border-t border-border p-2.5">
          <StackedField
            label="ID"
            hint="Internal name for integrations, it isn't recommended to change."
          >
            <div className="flex items-center gap-1.5">
              <Input
                ref={idInputRef}
                value={v.name}
                disabled={!idEditing}
                onChange={(e) => updateVariable(v.id, { name: e.target.value })}
                placeholder="id"
                className={cn(!idEditing && 'cursor-default opacity-60')}
              />
              <button
                type="button"
                title="Edit ID"
                disabled={idEditing}
                onClick={() => setIdEditing(true)}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border text-ink-muted hover:bg-surface-2 hover:text-ink disabled:cursor-default disabled:opacity-40"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          </StackedField>

          <StackedField label="Type" hint="Type of data.">
            <Select
              value={v.type}
              onChange={(e) => {
                const type = e.target.value as VariableType;
                const defaults: Record<VariableType, string | number> = {
                  text: '',
                  multitext: 'Line 1\nLine 2',
                  textfile: '',
                  image: '',
                  video: '',
                  color: '#ffffff',
                  number: 0,
                  time: 'today@18:00',
                };
                updateVariable(v.id, {
                  type,
                  defaultValue: defaults[type],
                  ...(type === 'multitext' && !v.name ? { name: 'multitext', label: 'multitext' } : {}),
                  ...(type === 'multitext' ? { name: v.name === 'var' || /^var\d+$/.test(v.name) ? 'multitext' : v.name } : {}),
                });
              }}
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </StackedField>

          <StackedField label="Name" hint="Name for operator.">
            <Input
              value={v.label}
              onChange={(e) => updateVariable(v.id, { label: e.target.value })}
              placeholder="name"
            />
          </StackedField>

          <StackedField
            label="Data-driven"
            hint="Filled by template Data pipeline. Hidden from Control unless Show in Control is on."
          >
            <div className="space-y-1.5">
              <Input
                value={v.drivenBy ?? ''}
                onChange={(e) => {
                  const drivenBy = e.target.value.trim();
                  updateVariable(v.id, {
                    drivenBy: drivenBy || undefined,
                    exposed: drivenBy ? (v.exposed === true) : v.exposed,
                  });
                }}
                placeholder="pipeline id (e.g. main)"
                className="font-mono text-[12px]"
              />
              <label className="flex items-center gap-2 text-[12px] text-ink-muted">
                <input
                  type="checkbox"
                  checked={v.exposed !== false && !v.drivenBy ? true : v.exposed === true}
                  onChange={(e) => updateVariable(v.id, { exposed: e.target.checked })}
                />
                Show in Control
                {v.drivenBy && v.exposed !== true && (
                  <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-faint">
                    hidden
                  </span>
                )}
              </label>
            </div>
          </StackedField>

          <StackedField label="Value" hint="Default value.">
            <DefaultValueInput v={v} onChange={(dv) => updateVariable(v.id, { defaultValue: dv })} />
          </StackedField>
        </div>
      )}
    </div>
  );
}

function DefaultValueInput({
  v,
  onChange,
}: {
  v: Variable;
  onChange: (dv: string | number) => void;
}) {
  const { upload, uploading } = useUpload();
  const fileRef = useRef<HTMLInputElement>(null);

  if (v.type === 'number') {
    return (
      <NumberInput
        value={typeof v.defaultValue === 'number' ? v.defaultValue : 0}
        onChange={onChange}
      />
    );
  }
  if (v.type === 'color') {
    return (
      <ColorInput value={String(v.defaultValue || '#ffffff')} onChange={onChange} />
    );
  }
  if (v.type === 'image' || v.type === 'video' || v.type === 'textfile') {
    return (
      <div className="flex items-center gap-2">
        <Input
          value={String(v.defaultValue || '')}
          onChange={(e) => onChange(e.target.value)}
          placeholder={v.type === 'textfile' ? 'TextFile URL' : 'media URL'}
          className="flex-1"
        />
        <input
          ref={fileRef}
          type="file"
          accept={v.type === 'image' ? 'image/*' : v.type === 'video' ? 'video/*' : '.txt,.json,text/plain,application/json'}
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const url = await upload(f);
            if (url) onChange(url);
            e.target.value = '';
          }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          title={v.type === 'textfile' ? 'Upload TextFile' : 'Upload media'}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border text-ink-muted hover:text-ink disabled:opacity-50"
        >
          {uploading ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Upload className="h-4 w-4" aria-hidden />
          )}
        </button>
      </div>
    );
  }
  if (v.type === 'multitext') {
    return (
      <textarea
        value={String(v.defaultValue || '')}
        onChange={(e) => onChange(e.target.value)}
        placeholder="multiline text"
        className="min-h-[72px] w-full resize-y rounded-md border border-border bg-surface-2 px-2 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus-visible:outline-none focus-visible:border-ring"
        spellCheck={false}
      />
    );
  }
  if (v.type === 'time') {
    return (
      <Input
        value={String(v.defaultValue || '')}
        onChange={(e) => onChange(e.target.value)}
        placeholder="today@18:00 · today+1 · now+5m"
        className="font-mono text-[12px]"
      />
    );
  }
  return (
    <Input
      value={String(v.defaultValue || '')}
      onChange={(e) => onChange(e.target.value)}
      placeholder="default value"
    />
  );
}
