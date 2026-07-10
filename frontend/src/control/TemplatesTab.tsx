import { useRef, useState } from 'react';
import { api, type TemplateRecord, type TemplateSummary } from '@/core/api';
import { Button } from '@/components/ui/Button';
import { toast } from '@/core/toast';
import { cn } from '@/lib/cn';
import { VariableValues } from '@/control/VariableValues';

export function TemplatesTab({
  templates, live, onTake, onUpdate, onClear,
}: {
  templates: TemplateSummary[];
  live: string[];
  onTake: (rec: TemplateRecord, values: Record<string, string | number>) => void;
  onUpdate: (templateId: string, values: Record<string, string | number>) => void;
  onClear: (templateId: string) => void;
}) {
  const [prep, setPrep] = useState<TemplateRecord | null>(null);
  const [values, setValues] = useState<Record<string, string | number>>({});
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function loadPrep(id: string) {
    try {
      const rec = await api.templates.get(id);
      setPrep(rec);
      const init: Record<string, string | number> = {};
      for (const v of rec.data.variables) init[v.id] = v.defaultValue;
      setValues(init);
    } catch (e) {
      toast.error(`Failed to load template: ${(e as Error).message}`);
    }
  }

  function setValue(varId: string, v: string | number) {
    setValues((prev) => {
      const next = { ...prev, [varId]: v };
      if (prep && live.includes(prep.id)) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => onUpdate(prep.id, next), 400);
      }
      return next;
    });
  }

  return (
    <div className="grid h-full grid-cols-[1fr_300px]">
      <div className="overflow-auto p-3">
        {templates.length === 0 ? (
          <p className="p-6 text-center text-[13px] text-ink-faint">No templates. Create one in Editor mode.</p>
        ) : (
          <ul className="space-y-1">
            {templates.map((t) => {
              const isLive = live.includes(t.id);
              return (
                <li key={t.id}>
                  <button
                    onClick={() => loadPrep(t.id)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-[13px] transition-colors',
                      prep?.id === t.id ? 'border-primary bg-primary/10' : 'border-border bg-surface hover:border-ink-faint',
                    )}
                  >
                    {isLive && <span className="h-2 w-2 shrink-0 rounded-full bg-live" aria-label="on air" />}
                    <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex flex-col border-l border-border">
        {!prep ? (
          <p className="p-4 text-[13px] text-ink-faint">Select a template to prepare.</p>
        ) : (
          <>
            <div className="border-b border-border p-3">
              <div className="truncate text-sm font-medium">{prep.name}</div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3">
              <VariableValues variables={prep.data.variables} values={values} onChange={setValue} />
            </div>
            <div className="grid grid-cols-3 gap-2 border-t border-border p-3">
              <Button variant="danger" onClick={() => onTake(prep, values)}>TAKE</Button>
              <Button variant="neutral" onClick={() => onUpdate(prep.id, values)} disabled={!live.includes(prep.id)}>UPDATE</Button>
              <Button variant="neutral" onClick={() => onClear(prep.id)} disabled={!live.includes(prep.id)}>CLEAR</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
