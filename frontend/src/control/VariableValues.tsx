import type { Variable } from '@runtime';
import { Input, NumberInput, ColorInput, Field } from '@/components/ui/form';

export function VariableValues({
  variables, values, onChange,
}: {
  variables: Variable[];
  values: Record<string, string | number>;
  onChange: (id: string, v: string | number) => void;
}) {
  if (variables.length === 0) {
    return <p className="text-[12px] text-ink-faint">This template has no variables.</p>;
  }
  return (
    <div className="space-y-2">
      {variables.map((v) => (
        <Field key={v.id} label={v.label || v.name}>
          {v.type === 'number' ? (
            <NumberInput
              value={Number(values[v.id] ?? 0)}
              aria-label={v.label || v.name}
              onChange={(n) => onChange(v.id, n)}
            />
          ) : v.type === 'color' ? (
            <ColorInput value={String(values[v.id] ?? '#ffffff')} onChange={(c) => onChange(v.id, c)} />
          ) : (
            <Input value={String(values[v.id] ?? '')} onChange={(e) => onChange(v.id, e.target.value)} />
          )}
        </Field>
      ))}
    </div>
  );
}
