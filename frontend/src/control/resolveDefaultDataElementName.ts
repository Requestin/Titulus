import type { Template, Variable } from '@runtime';

/**
 * Resolve `template.defaultNameForDataElements` by replacing `@varName`
 * placeholders with variable values (by name, then id). Literals stay as-is.
 * Example: `Гео-@text1` + text1="Москва" → `Гео-Москва`.
 */
export function resolveDefaultDataElementName(
  template: Pick<Template, 'name' | 'variables' | 'defaultNameForDataElements'>,
  values: Record<string, string | number> = {},
): string {
  const pattern = template.defaultNameForDataElements?.trim();
  if (!pattern) return template.name || 'Data element';

  const byName = new Map<string, Variable>();
  const byId = new Map<string, Variable>();
  for (const variable of template.variables) {
    byName.set(variable.name, variable);
    byId.set(variable.id, variable);
  }

  return pattern.replace(/@([A-Za-z_][\w]*)/g, (match, key: string) => {
    const variable = byName.get(key) ?? byId.get(key);
    if (!variable) return match;
    const raw = values[variable.id] ?? values[variable.name] ?? variable.defaultValue;
    return String(raw ?? '');
  });
}
