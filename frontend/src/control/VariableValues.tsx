import type { Variable } from '@runtime';
import { Input, NumberInput, ColorInput, Field } from '@/components/ui/form';
import { exposedVariables } from '@/core/prepareTemplateData';

export function VariableValues({
  variables, values, onChange,
}: {
  variables: Variable[];
  values: Record<string, string | number>;
  onChange: (id: string, v: string | number) => void;
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
            <NumberInput value={Number(values[v.id] ?? 0)} onChange={(n) => onChange(v.id, n)} />
          ) : v.type === 'color' ? (
            <ColorInput value={String(values[v.id] ?? '#ffffff')} onChange={(c) => onChange(v.id, c)} />
          ) : v.type === 'multitext' ? (
            <textarea
              value={String(values[v.id] ?? '')}
              onChange={(e) => onChange(v.id, e.target.value)}
              className="min-h-[72px] w-full resize-y rounded-md border border-border bg-surface-2 px-2 py-1.5 text-[13px] text-ink"
              spellCheck={false}
            />
          ) : (
            <Input value={String(values[v.id] ?? '')} onChange={(e) => onChange(v.id, e.target.value)} />
          )}
        </Field>
      ))}
    </div>
  );
}
