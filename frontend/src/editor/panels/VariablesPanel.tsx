// frontend/src/editor/panels/VariablesPanel.tsx
//
// CRUD for template variables. image/video defaults can be uploaded (transcoded
// to VP9/WebM alpha for video). Bind layer fields to these in Properties.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Plus, Trash2, Upload, Loader2, Pencil } from 'lucide-react';
import type { Variable, VariableType } from '@runtime';
import { useEditor } from '../store';
import { useUpload } from '../useUpload';
import { Input, NumberInput, Select, ColorInput } from '@/components/ui/form';
import { cn } from '@/lib/cn';

const TYPES: VariableType[] = ['text', 'number', 'color', 'image', 'video'];

export function VariablesPanel() {
  const template = useEditor((s) => s.template);
  const addVariable = useEditor((s) => s.addVariable);
  if (!template) return null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-[12px] font-semibold text-ink-muted">Variables</span>
        <button
          onClick={addVariable}
          title="Add variable"
          className="grid h-7 w-7 place-items-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink"
        >
          <Plus className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {template.variables.length === 0 && (
          <p className="py-6 text-center text-[12px] text-ink-faint">
            No variables. Add one, then bind a layer field to it.
          </p>
        )}
        {template.variables.map((v) => <VariableRow key={v.id} v={v} />)}
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

function VariableRow({ v }: { v: Variable }) {
  const updateVariable = useEditor((s) => s.updateVariable);
  const removeVariable = useEditor((s) => s.removeVariable);
  const [idEditing, setIdEditing] = useState(false);
  const idInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (idEditing) idInputRef.current?.focus();
  }, [idEditing]);

  return (
    <div className="space-y-3 rounded-md border border-border bg-surface p-2.5">
      <div className="flex justify-end">
        <button
          onClick={() => removeVariable(v.id)}
          title="Delete variable"
          className="grid h-7 w-7 place-items-center rounded-md text-ink-faint hover:text-danger"
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </button>
      </div>

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
          onChange={(e) =>
            updateVariable(v.id, {
              type: e.target.value as VariableType,
              defaultValue: e.target.value === 'number' ? 0 : '',
            })
          }
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

      <StackedField label="Value" hint="Default value.">
        <DefaultValueInput v={v} onChange={(dv) => updateVariable(v.id, { defaultValue: dv })} />
      </StackedField>
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
  if (v.type === 'image' || v.type === 'video') {
    return (
      <div className="flex items-center gap-2">
        <Input
          value={String(v.defaultValue || '')}
          onChange={(e) => onChange(e.target.value)}
          placeholder="media URL"
          className="flex-1"
        />
        <input
          ref={fileRef}
          type="file"
          accept={v.type === 'image' ? 'image/*' : 'video/*'}
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
          title="Upload media"
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
  return (
    <Input
      value={String(v.defaultValue || '')}
      onChange={(e) => onChange(e.target.value)}
      placeholder="default value"
    />
  );
}
