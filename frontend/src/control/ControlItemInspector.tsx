import { useEffect, useRef, useState } from 'react';
import type { Template } from '@runtime';
import { api, type DataElement, type TemplateRecord } from '@/core/api';
import { resolveDefaultDataElementName } from '@/control/resolveDefaultDataElementName';
import { VariableValues } from '@/control/VariableValues';
import { Button } from '@/components/ui/Button';
import { toast } from '@/core/toast';

export type InspectorTarget =
  | { kind: 'template'; templateId: string }
  | { kind: 'dataElement'; dataElementId: string };

export function ControlItemInspector({
  target,
  dataElements,
  onDataElementsChange,
  onCancel,
  onTake,
  onUpdate,
  onClear,
  onContinue,
  live,
  canContinue,
}: {
  target: InspectorTarget | null;
  dataElements: DataElement[];
  onDataElementsChange: (next: DataElement[]) => void;
  onCancel: () => void;
  onTake?: (rec: TemplateRecord, values: Record<string, string | number>) => void;
  onUpdate?: (templateId: string, values: Record<string, string | number>) => void;
  onClear?: (templateId: string) => void;
  onContinue?: (templateId: string) => void;
  live?: string[];
  canContinue?: (templateId: string) => boolean;
}) {
  const [prep, setPrep] = useState<TemplateRecord | null>(null);
  const [values, setValues] = useState<Record<string, string | number>>({});
  const [editingDeId, setEditingDeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveIds = live ?? [];

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!target) {
        setPrep(null);
        setValues({});
        setEditingDeId(null);
        return;
      }
      try {
        if (target.kind === 'template') {
          const rec = await api.templates.get(target.templateId);
          if (cancelled) return;
          setPrep(rec);
          setEditingDeId(null);
          const init: Record<string, string | number> = {};
          for (const v of rec.data.variables) init[v.id] = v.defaultValue;
          setValues(init);
          return;
        }
        const de = dataElements.find((item) => item.id === target.dataElementId);
        if (!de) {
          setPrep(null);
          setEditingDeId(null);
          return;
        }
        const rec = await api.templates.get(de.templateId);
        if (cancelled) return;
        setPrep(rec);
        setEditingDeId(de.id);
        const init: Record<string, string | number> = {};
        for (const v of rec.data.variables) {
          const fromPayload = de.payload[v.id] ?? de.payload[v.name];
          init[v.id] = (typeof fromPayload === 'string' || typeof fromPayload === 'number')
            ? fromPayload
            : v.defaultValue;
        }
        setValues(init);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to load inspector');
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [target, dataElements]);

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  function setValue(varId: string, v: string | number) {
    setValues((prev) => {
      const next = { ...prev, [varId]: v };
      if (prep && liveIds.includes(prep.id) && onUpdate) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => onUpdate(prep.id, next), 400);
      }
      return next;
    });
  }

  async function saveAsNew() {
    if (!prep) return;
    const prefill = resolveDefaultDataElementName(prep.data, values);
    const name = window.prompt('Data element name', prefill);
    if (!name?.trim()) return;
    setBusy(true);
    try {
      const created = await api.dataElements.create({
        name: name.trim(),
        templateId: prep.id,
        payload: { ...values },
      });
      onDataElementsChange([created, ...dataElements.filter((item) => item.id !== created.id)]);
      setEditingDeId(created.id);
      toast.success('Data element created');
    } catch (error) {
      toast.error(`Save as new failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!prep || !editingDeId) return;
    setBusy(true);
    try {
      const updated = await api.dataElements.update(editingDeId, { payload: { ...values } });
      onDataElementsChange(dataElements.map((item) => (item.id === updated.id ? updated : item)));
      toast.success('Data element saved');
    } catch (error) {
      toast.error(`Save failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  if (!target) {
    return (
      <p className="p-3 text-[12px] text-ink-faint">
        Select a template or data element to prepare variables.
      </p>
    );
  }

  if (!prep) {
    return <p className="p-3 text-[12px] text-ink-faint">Loading…</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border p-3">
        <div className="truncate text-sm font-medium">{prep.name}</div>
        {editingDeId && (
          <div className="truncate text-[11px] text-ink-faint">
            Editing DE: {dataElements.find((item) => item.id === editingDeId)?.name ?? editingDeId}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <VariableValues variables={prep.data.variables} values={values} onChange={setValue} />
      </div>
      <div className="space-y-2 border-t border-border p-3">
        <div className="grid grid-cols-3 gap-2">
          <Button size="sm" variant="neutral" disabled={busy} onClick={() => void saveAsNew()}>
            Save as new
          </Button>
          <Button size="sm" variant="primary" disabled={busy || !editingDeId} onClick={() => void save()}>
            Save
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>
        {onTake && (
          <div className="grid grid-cols-4 gap-2">
            <Button size="sm" variant="danger" onClick={() => onTake(prep, values)}>TAKE</Button>
            <Button
              size="sm"
              variant="neutral"
              onClick={() => onUpdate?.(prep.id, values)}
              disabled={!liveIds.includes(prep.id)}
            >
              UPDATE
            </Button>
            <Button
              size="sm"
              variant="neutral"
              onClick={() => onClear?.(prep.id)}
              disabled={!liveIds.includes(prep.id)}
            >
              CLEAR
            </Button>
            <Button
              size="sm"
              variant="neutral"
              onClick={() => onContinue?.(prep.id)}
              disabled={!canContinue?.(prep.id)}
            >
              CONTINUE
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Build a quick preview title from a template + values (for prompts). */
export function previewDefaultDeName(template: Template, values: Record<string, string | number>): string {
  return resolveDefaultDataElementName(template, values);
}
