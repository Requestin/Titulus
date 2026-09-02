import { useEffect, useRef, useState } from 'react';
import type { Template } from '@runtime';
import { hasUpdateDirector } from '@runtime';
import { api, type DataElement, type TemplateRecord } from '@/core/api';
import { resolveDefaultDataElementName } from '@/control/resolveDefaultDataElementName';
import { VariableValues } from '@/control/VariableValues';
import { prepareForAir } from '@/control/prepareForAir';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/form';
import { toast } from '@/core/toast';

export type InspectorTarget =
  | { kind: 'template'; templateId: string }
  | { kind: 'dataElement'; dataElementId: string };

export function ControlItemInspector({
  target,
  dataElements,
  onDataElementsChange,
  onCancel,
  channelId,
  live = false,
  send,
}: {
  target: InspectorTarget | null;
  dataElements: DataElement[];
  onDataElementsChange: (next: DataElement[]) => void;
  onCancel: () => void;
  channelId?: string;
  live?: boolean;
  send?: (cmd: {
    type: 'take' | 'update' | 'clear';
    channelId: string;
    templateId?: string;
    template?: unknown;
    variables?: Record<string, string | number>;
  }) => boolean;
}) {
  const [prep, setPrep] = useState<TemplateRecord | null>(null);
  const [values, setValues] = useState<Record<string, string | number>>({});
  const [editingDeId, setEditingDeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nameDialogOpen, setNameDialogOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!target) {
        setPrep(null);
        setValues({});
        setEditingDeId(null);
        setNameDialogOpen(false);
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

  function setValue(varId: string, v: string | number) {
    setValues((prev) => ({ ...prev, [varId]: v }));
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
      setNameDialogOpen(false);
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

  async function playTake() {
    if (!prep || !channelId || !send) return;
    if (live && hasUpdateDirector(prep.data.timeline)) {
      await playUpdate();
      return;
    }
    setBusy(true);
    try {
      const prepared = await prepareForAir(prep.data, 'take', values);
      if (prepared.blocked) {
        toast.error(prepared.errors[0]?.message || 'TAKE blocked');
        return;
      }
      const ok = send({
        type: 'take',
        channelId,
        templateId: prep.id,
        template: prepared.template ?? prep.data,
        variables: { ...values, ...prepared.overrides },
      });
      if (!ok) toast.error('Control socket disconnected');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'TAKE failed');
    } finally {
      setBusy(false);
    }
  }

  async function playUpdate() {
    if (!prep || !channelId || !send) return;
    setBusy(true);
    try {
      const prepared = await prepareForAir(prep.data, 'update', values);
      if (prepared.blocked) {
        toast.error(prepared.errors[0]?.message || 'UPDATE blocked');
        return;
      }
      const ok = send({
        type: 'update',
        channelId,
        templateId: prep.id,
        variables: { ...values, ...prepared.overrides },
      });
      if (!ok) toast.error('Control socket disconnected');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'UPDATE failed');
    } finally {
      setBusy(false);
    }
  }

  function playClear() {
    if (!prep || !channelId || !send) return;
    send({ type: 'clear', channelId, templateId: prep.id });
  }

  const canPlay = Boolean(channelId && send && target?.kind === 'template');
  const canUpdate = canPlay && live && Boolean(prep && hasUpdateDirector(prep.data.timeline));

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
      <div className="border-t border-border p-3">
        {canPlay && (
          <div className="mb-2 grid grid-cols-3 gap-2">
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void playTake()}>
              Take
            </Button>
            <Button size="sm" variant="neutral" disabled={busy || !canUpdate} onClick={() => void playUpdate()}>
              Update
            </Button>
            <Button size="sm" variant="ghost" disabled={busy || !live} onClick={playClear}>
              Clear
            </Button>
          </div>
        )}
        <div className="grid grid-cols-3 gap-2">
          <Button size="sm" variant="neutral" disabled={busy} onClick={openSaveAsNew}>
            Save as new
          </Button>
          <Button size="sm" variant="primary" disabled={busy || !editingDeId} onClick={() => void save()}>
            Save
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
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
