import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api, type DataElement, type TemplateSummary } from '@/core/api';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/form';
import { toast } from '@/core/toast';

export function DataElementsTab({
  templates,
  onTake,
}: {
  templates: TemplateSummary[];
  onTake: (templateId: string, values: Record<string, string | number>) => void;
}) {
  const [items, setItems] = useState<DataElement[]>([]);
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    void api.dataElements.list().then(setItems).catch((error) => {
      toast.error(`Failed to load data elements: ${(error as Error).message}`);
    });
  }, []);

  useEffect(() => {
    if (!templateId && templates[0]) setTemplateId(templates[0].id);
  }, [templateId, templates]);

  const selected = useMemo(
    () => items.find((item) => item.id === selectedId) ?? null,
    [items, selectedId],
  );

  async function saveAs() {
    if (!name.trim() || !templateId) {
      toast.error('Name and template are required');
      return;
    }
    try {
      const created = await api.dataElements.create({
        name: name.trim(),
        templateId,
        payload: selected?.payload ?? {},
      });
      setItems((cur) => [created, ...cur]);
      setSelectedId(created.id);
      toast.success('Data element saved');
    } catch (error) {
      toast.error(`Save failed: ${(error as Error).message}`);
    }
  }

  async function remove(id: string) {
    try {
      await api.dataElements.remove(id);
      setItems((cur) => cur.filter((item) => item.id !== id));
      if (selectedId === id) setSelectedId(null);
    } catch (error) {
      toast.error(`Delete failed: ${(error as Error).message}`);
    }
  }

  return (
    <div className="grid h-full grid-cols-[1fr_300px]">
      <div className="overflow-auto p-3">
        {items.length === 0 ? (
          <p className="p-6 text-center text-[13px] text-ink-faint">No data elements yet.</p>
        ) : (
          <ul className="space-y-1">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-[13px] ${
                    selectedId === item.id ? 'border-primary bg-primary/10' : 'border-border bg-surface hover:border-ink-faint'
                  }`}
                >
                  <span className="min-w-0 truncate font-medium">{item.name}</span>
                  <span className="text-[11px] text-ink-faint">
                    {templates.find((template) => template.id === item.templateId)?.name ?? item.templateId}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-col gap-3 border-l border-border p-3">
        <Field label="Save as">
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Morning open" />
        </Field>
        <Field label="Template">
          <Select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>{template.name}</option>
            ))}
          </Select>
        </Field>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void saveAs()}>
            <Plus className="h-4 w-4" aria-hidden />
            Save as
          </Button>
          {selected && (
            <Button
              size="sm"
              variant="danger"
              onClick={() => void remove(selected.id)}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </Button>
          )}
        </div>
        {selected && (
          <>
            <p className="text-[12px] text-ink-muted">
              Bind this DE on a rundown slot. TAKE uses its payload as variables.
            </p>
            <Button
              variant="danger"
              onClick={() => onTake(selected.templateId, flattenPayload(selected.payload))}
            >
              TAKE
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function flattenPayload(payload: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string' || typeof value === 'number') out[key] = value;
  }
  return out;
}
