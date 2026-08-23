export interface TemplateLibraryItem {
  id: string;
  name: string;
  updated_at: string;
}

export type TemplateSortBy = 'name' | 'modified';

export const TEMPLATE_SORT_BY = ['modified', 'name'] as const satisfies readonly TemplateSortBy[];

function compareName(a: TemplateLibraryItem, b: TemplateLibraryItem): number {
  const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  if (byName !== 0) return byName;
  return a.id.localeCompare(b.id);
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export function sortTemplates<T extends TemplateLibraryItem>(
  items: readonly T[],
  by: TemplateSortBy,
): T[] {
  const copy = items.slice();
  if (by === 'name') {
    copy.sort(compareName);
    return copy;
  }

  copy.sort((left, right) => {
    const delta = timestamp(right.updated_at) - timestamp(left.updated_at);
    if (delta !== 0) return delta;
    return compareName(left, right);
  });
  return copy;
}

export function nextTemplateName(current: string, draft: string): string | null {
  const next = draft.trim();
  if (!next || next === current.trim()) return null;
  return next;
}
