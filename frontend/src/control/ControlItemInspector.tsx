import { useEffect, useRef, useState } from 'react';
import type { Template } from '@runtime';
import { api, type DataElement, type TemplateRecord } from '@/core/api';
import { resolveDefaultDataElementName } from '@/control/resolveDefaultDataElementName';
import { VariableValues } from '@/control/VariableValues';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/form';
import { toast } from '@/core/toast';

export type InspectorTarget =
  | { kind: 'template'; templateId: string }
  | { kind: 'dataElement'; dataElementId: string }
  | {
      kind: 'slot';
      rundownId: string;
      slotId: string;
      templateId: string;
      dataElementId?: string;
      name?: string;
      /** Current slot.vars used to seed the form (TAKE-without-save reads live draft). */
      seedVars?: Record<string, string | number>;
    };

export function ControlItemInspector({
  target,
  dataElements,
  onDataElementsChange,
  onCancel,
  onSlotVarsSave,
  onDraftValuesChange,
}: {
  target: InspectorTarget | null;
  dataElements: DataElement[];
  onDataElementsChange: (next: DataElement[]) => void;
  onCancel: () => void;
  /** Persist edited variable values onto a rundown slot (and optional linked DE). */
  onSlotVarsSave?: (
    rundownId: string,
    slotId: string,
    vars: Record<string, string | number>,
    dataElementId?: string | null,
  ) => void;
  /** Live draft values for TAKE without Save (slot inspector). */
  onDraftValuesChange?: (draft: {
    slotId: string;
    values: Record<string, string | number>;
  } | null) => void;
}) {
  const [prep, setPrep] = useState<TemplateRecord | null>(null);
  const [values, setValues] = useState<Record<string, string | number>>({});
  const [editingDeId, setEditingDeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nameDialogOpen, setNameDialogOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [slotMeta, setSlotMeta] = useState<{
    rundownId: string;
    slotId: string;
    name?: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!target) {
        setPrep(null);
        setValues({});
        setEditingDeId(null);
        setSlotMeta(null);
        setNameDialogOpen(false);
        onDraftValuesChange?.(null);
        return;
      }
      try {
        if (target.kind === 'template') {
          const rec = await api.templates.get(target.templateId);
          if (cancelled) return;
          setPrep(rec);
          setEditingDeId(null);
          setSlotMeta(null);
          const init: Record<string, string | number> = {};
          for (const v of rec.data.variables) init[v.id] = v.defaultValue;
          setValues(init);
          onDraftValuesChange?.(null);
          return;
        }
        if (target.kind === 'slot') {
          const rec = await api.templates.get(target.templateId);
          if (cancelled) return;
          setPrep(rec);
          setSlotMeta({
            rundownId: target.rundownId,
            slotId: target.slotId,
            name: target.name,
          });
          const de = target.dataElementId
            ? dataElements.find((item) => item.id === target.dataElementId)
            : undefined;
          setEditingDeId(de?.id ?? null);
          const fromDe = de ? flattenPayload(de.payload) : {};
          const seed = target.seedVars ?? {};
          const init: Record<string, string | number> = {};
          for (const v of rec.data.variables) {
            init[v.id] = seed[v.id] ?? seed[v.name] ?? fromDe[v.id] ?? fromDe[v.name] ?? v.defaultValue;
          }
          setValues(init);
          onDraftValuesChange?.({ slotId: target.slotId, values: init });
          return;
        }
        const de = dataElements.find((item) => item.id === target.dataElementId);
        if (!de) {
          setPrep(null);
          setEditingDeId(null);
          setSlotMeta(null);
          return;
        }
        const rec = await api.templates.get(de.templateId);
        if (cancelled) return;
        setPrep(rec);
        setEditingDeId(de.id);
        setSlotMeta(null);
        const init: Record<string, string | number> = {};
        for (const v of rec.data.variables) {
          const fromPayload = de.payload[v.id] ?? de.payload[v.name];
          init[v.id] = (typeof fromPayload === 'string' || typeof fromPayload === 'number')
            ? fromPayload
            : v.defaultValue;
        }
        setValues(init);
        onDraftValuesChange?.(null);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to load inspector');
      }
    }
    void load();
    return () => { cancelled = true; };
    // Intentionally omit onDraftValuesChange from deps — parent passes stable setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, dataElements]);

  function setValue(varId: string, v: string | number) {
    setValues((prev) => {
      const next = { ...prev, [varId]: v };
      if (slotMeta) onDraftValuesChange?.({ slotId: slotMeta.slotId, values: next });
      return next;
    });
  }

  function openSaveAsNew() {
    if (!prep) return;
    setNameDraft(resolveDefaultDataElementName(prep.data, values));
    setNameDialogOpen(true);
  }

  async function confirmSaveAsNew(name: string) {
    if (!prep) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const created = await api.dataElements.create({
        name: trimmed,
        templateId: prep.id,
        payload: { ...values },
      });
      onDataElementsChange([created, ...dataElements.filter((item) => item.id !== created.id)]);
      setEditingDeId(created.id);
      if (slotMeta) {
        onSlotVarsSave?.(slotMeta.rundownId, slotMeta.slotId, { ...values }, created.id);
      }
      setNameDialogOpen(false);
      toast.success('Data element created');
    } catch (error) {
      toast.error(`Save as new failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!prep) return;
    setBusy(true);
    try {
      let deId = editingDeId;
      if (editingDeId) {
        const updated = await api.dataElements.update(editingDeId, { payload: { ...values } });
        onDataElementsChange(dataElements.map((item) => (item.id === updated.id ? updated : item)));
        deId = updated.id;
      }
      if (slotMeta) {
        onSlotVarsSave?.(slotMeta.rundownId, slotMeta.slotId, { ...values }, deId);
        toast.success('Slot variables saved');
      } else if (editingDeId) {
        toast.success('Data element saved');
      } else {
        toast.error('Nothing to save — use Save as new');
        return;
      }
    } catch (error) {
      toast.error(`Save failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const canSave = Boolean(editingDeId || slotMeta);
  const title = slotMeta?.name || prep?.name || 'Item';

  if (!target) {
    return (
      <p className="p-3 text-[12px] text-ink-faint">
        Select a rundown item, template, or data element to prepare variables.
      </p>
    );
  }

  if (!prep) {
    return <p className="p-3 text-[12px] text-ink-faint">Loading…</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border p-3">
        <div className="truncate text-sm font-medium">{title}</div>
        {slotMeta && prep.name !== title && (
          <div className="truncate text-[11px] text-ink-faint">{prep.name}</div>
        )}
        {editingDeId && (
          <div className="truncate text-[11px] text-ink-faint">
            Editing DE: {dataElements.find((item) => item.id === editingDeId)?.name ?? editingDeId}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <VariableValues variables={prep.data.variables} values={values} onChange={setValue} />
      </div>
      <div className="border-t border-border p-3">
        <div className="grid grid-cols-3 gap-2">
          <Button size="sm" variant="neutral" disabled={busy} onClick={openSaveAsNew}>
            Save as new
          </Button>
          <Button size="sm" variant="primary" disabled={busy || !canSave} onClick={() => void save()}>
            Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              onDraftValuesChange?.(null);
              onCancel();
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
      {nameDialogOpen && (
        <DataElementNameDialog
          value={nameDraft}
          busy={busy}
          onChange={setNameDraft}
          onConfirm={() => void confirmSaveAsNew(nameDraft)}
          onCancel={() => { if (!busy) setNameDialogOpen(false); }}
        />
      )}
    </div>
  );
}

function flattenPayload(payload: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (typeof value === 'string' || typeof value === 'number') out[key] = value;
  }
  return out;
}

function DataElementNameDialog({
  value,
  busy,
  onChange,
  onConfirm,
  onCancel,
}: {
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!busy) onCancel();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled])',
      )];
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onCancel]);

  return (
    <div
      className="fixed inset-0 z-modal grid place-items-center bg-bg/70 px-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="de-name-title"
        className="w-full max-w-md rounded-xl border border-border bg-surface p-5 shadow-2xl"
      >
        <h2 id="de-name-title" className="text-base font-semibold text-ink">
          Data element name
        </h2>
        <p className="mt-1 text-[13px] text-ink-muted">
          Name for the new data element.
        </p>
        <label className="mt-4 block">
          <span className="sr-only">Name</span>
          <Input
            ref={inputRef}
            value={value}
            disabled={busy}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (value.trim() && !busy) onConfirm();
              }
            }}
            placeholder="Name"
          />
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="primary" onClick={onConfirm} disabled={busy || !value.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="neutral" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Build a quick preview title from a template + values (for prompts). */
export function previewDefaultDeName(template: Template, values: Record<string, string | number>): string {
  return resolveDefaultDataElementName(template, values);
}
