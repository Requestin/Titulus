import { useEffect, useMemo, useState } from 'react';
import type { Variable } from '@runtime';
import { Button } from '@/components/ui/Button';
import { Field, Input, NumberInput, ColorInput } from '@/components/ui/form';
import { MediaUploadButton } from '@/editor/MediaUploadButton';
import { api, type DataElement } from '@/core/api';
import { toast } from '@/core/toast';
import { exposedVariables } from '@/core/prepareTemplateData';
import { cn } from '@/lib/cn';

export type VarsSelection =
  | { kind: 'none' }
  | {
    kind: 'template';
    templateId: string;
    templateName: string;
    variables: Variable[];
    values: Record<string, string | number>;
  }
  | {
    kind: 'dataElement';
    dataElement: DataElement;
    variables: Variable[];
    values: Record<string, string | number>;
  }
  | {
    kind: 'slot';
    rundownId: string;
    slotId: string;
    templateId: string;
    dataElementId?: string | null;
    variables: Variable[];
    values: Record<string, string | number>;
    missing: boolean;
  };

export function buildValuesFromVars(
  variables: Variable[],
  vars: Record<string, string | number>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const v of variables) out[v.id] = vars[v.id] ?? v.defaultValue;
  return out;
}

export function defaultsFromVariables(variables: Variable[]): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const v of variables) out[v.id] = v.defaultValue;
  return out;
}

function VarsEditor({
  variables,
  values,
  onChange,
  disabled,
}: {
  variables: Variable[];
  values: Record<string, string | number>;
  onChange: (id: string, v: string | number) => void;
  disabled?: boolean;
}) {
  const visible = exposedVariables(variables);
  if (visible.length === 0) {
    return <p className="text-[12px] text-ink-faint">This template has no operator variables.</p>;
  }
  return (
    <div className="space-y-2">
      {visible.map((v) => (
        <Field key={v.id} label={v.label || v.name}>
          {v.type === 'number' ? (
            <NumberInput
              value={Number(values[v.id] ?? 0)}
              disabled={disabled}
              onChange={(n) => onChange(v.id, n)}
            />
          ) : v.type === 'color' ? (
            <div className={cn(disabled && 'pointer-events-none opacity-50')}>
              <ColorInput
                value={String(values[v.id] ?? '#ffffff')}
                onChange={(c) => onChange(v.id, c)}
              />
            </div>
          ) : v.type === 'image' || v.type === 'video' || v.type === 'textfile' ? (
            <div className="space-y-1">
              <Input
                value={String(values[v.id] ?? '')}
                disabled={disabled}
                placeholder={v.type === 'textfile' ? 'TextFile URL' : undefined}
                onChange={(e) => onChange(v.id, e.target.value)}
              />
              {!disabled && (
                <MediaUploadButton
                  accept={v.type === 'video' ? 'video/*' : v.type === 'textfile' ? '.txt,text/plain,.json,application/json' : 'image/*'}
                  onUploaded={(url) => onChange(v.id, url)}
                  label={v.type === 'video' ? 'Upload video' : v.type === 'textfile' ? 'Upload TextFile' : 'Upload image'}
                />
              )}
            </div>
          ) : v.type === 'multitext' ? (
            <textarea
              value={String(values[v.id] ?? '')}
              disabled={disabled}
              onChange={(e) => onChange(v.id, e.target.value)}
              className="min-h-[72px] w-full resize-y rounded-md border border-border bg-surface-2 px-2 py-1.5 text-[13px] text-ink disabled:opacity-50"
              spellCheck={false}
            />
          ) : (
            <Input
              value={String(values[v.id] ?? '')}
              disabled={disabled}
              onChange={(e) => onChange(v.id, e.target.value)}
            />
          )}
        </Field>
      ))}
    </div>
  );
}

function NameModal({
  open,
  defaultName,
  onSave,
  onCancel,
}: {
  open: boolean;
  defaultName: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(defaultName);
  useEffect(() => {
    if (open) setName(defaultName);
  }, [open, defaultName]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-modal grid place-items-center bg-bg/70 px-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="de-name-title"
        className="w-full max-w-sm rounded-xl border border-border bg-surface p-5 shadow-2xl"
      >
        <h3 id="de-name-title" className="text-sm font-semibold text-ink">Enter name for DataElement</h3>
        <div className="mt-3">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) onSave(name.trim());
              if (e.key === 'Escape') onCancel();
            }}
          />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="primary" disabled={!name.trim()} onClick={() => onSave(name.trim())}>Save</Button>
          <Button variant="neutral" onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}

export function ControlVariablesPanel({
  selection,
  onChangeValues,
  onClearSelection,
  onSlotSaved,
  onDataElementsChanged,
}: {
  selection: VarsSelection;
  onChangeValues: (values: Record<string, string | number>) => void;
  onClearSelection: () => void;
  onSlotSaved: (rundownId: string, slotId: string, values: Record<string, string | number>) => void;
  onDataElementsChanged: () => void;
}) {
  const [nameModal, setNameModal] = useState<{ open: boolean; defaultName: string; mode: 'from-template' | 'from-de' | 'from-slot' }>({
    open: false,
    defaultName: '',
    mode: 'from-template',
  });
  const [baseline, setBaseline] = useState<Record<string, string | number>>({});

  useEffect(() => {
    if (selection.kind === 'none') {
      setBaseline({});
      return;
    }
    setBaseline({ ...selection.values });
  }, [selection.kind === 'none' ? 'none' : `${selection.kind}:${'slotId' in selection ? selection.slotId : 'dataElement' in selection ? selection.dataElement.id : selection.templateId}`]);

  const dirty = useMemo(() => {
    if (selection.kind === 'none') return false;
    return JSON.stringify(selection.values) !== JSON.stringify(baseline);
  }, [selection, baseline]);

  if (selection.kind === 'none') {
    return (
      <div>
        <h3 className="mb-2 text-[12px] font-semibold text-ink-muted">Variables</h3>
        <p className="text-[12px] text-ink-faint">Select a template, data element, or rundown slot.</p>
      </div>
    );
  }

  const variables = selection.variables;
  const values = selection.values;
  const missing = selection.kind === 'slot' && selection.missing;

  function setValue(id: string, v: string | number) {
    onChangeValues({ ...values, [id]: v });
  }

  async function createDataElement(name: string, templateId: string, vars: Record<string, string | number>) {
    try {
      await api.dataElements.create({ templateId, name, vars });
      toast.success(`DataElement "${name}" saved`);
      onDataElementsChanged();
      setNameModal((m) => ({ ...m, open: false }));
    } catch (e) {
      toast.error(`Save failed: ${(e as Error).message}`);
    }
  }

  async function saveDataElement() {
    if (selection.kind !== 'dataElement') return;
    try {
      await api.dataElements.update(selection.dataElement.id, { vars: values });
      toast.success('DataElement saved');
      setBaseline({ ...values });
      onDataElementsChanged();
    } catch (e) {
      toast.error(`Save failed: ${(e as Error).message}`);
    }
  }

  function cancel() {
    onChangeValues({ ...baseline });
    onClearSelection();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <h3 className="mb-2 shrink-0 text-[12px] font-semibold text-ink-muted">Variables</h3>
      <div className="min-h-0 flex-1 overflow-auto">
        {missing ? (
          <p className="text-[12px] font-semibold text-live">NOT FOUND IN DB</p>
        ) : (
          <VarsEditor variables={variables} values={values} onChange={setValue} />
        )}
      </div>
      {!missing && (
        <div className="mt-3 flex shrink-0 flex-wrap gap-2 border-t border-border pt-3">
          {selection.kind === 'template' && (
            <>
              <Button
                variant="danger"
                size="sm"
                onClick={() => setNameModal({ open: true, defaultName: selection.templateName, mode: 'from-template' })}
              >
                Save as DataElement
              </Button>
              <Button variant="neutral" size="sm" onClick={cancel}>Cancel</Button>
            </>
          )}
          {selection.kind === 'dataElement' && (
            <>
              <Button
                variant="neutral"
                size="sm"
                onClick={() => setNameModal({
                  open: true,
                  defaultName: `${selection.dataElement.name} (copy)`,
                  mode: 'from-de',
                })}
              >
                Save as new
              </Button>
              <Button variant="primary" size="sm" onClick={() => void saveDataElement()}>Save</Button>
              <Button variant="neutral" size="sm" onClick={cancel}>Cancel</Button>
            </>
          )}
          {selection.kind === 'slot' && (
            <>
              <Button
                variant="neutral"
                size="sm"
                onClick={() => setNameModal({
                  open: true,
                  defaultName: 'DataElement',
                  mode: 'from-slot',
                })}
              >
                Save as new
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={!dirty}
                onClick={() => {
                  onSlotSaved(selection.rundownId, selection.slotId, values);
                  setBaseline({ ...values });
                  toast.success('Slot variables saved');
                }}
              >
                Save
              </Button>
              <Button variant="neutral" size="sm" onClick={cancel}>Cancel</Button>
            </>
          )}
        </div>
      )}

      <NameModal
        open={nameModal.open}
        defaultName={nameModal.defaultName}
        onCancel={() => setNameModal((m) => ({ ...m, open: false }))}
        onSave={(name) => {
          if (selection.kind === 'template' && nameModal.mode === 'from-template') {
            void createDataElement(name, selection.templateId, values);
          } else if (selection.kind === 'dataElement' && nameModal.mode === 'from-de') {
            void createDataElement(name, selection.dataElement.templateId, values);
          } else if (selection.kind === 'slot' && nameModal.mode === 'from-slot') {
            void createDataElement(name, selection.templateId, values);
          }
        }}
      />
    </div>
  );
}
