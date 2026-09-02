export interface TemplateLibraryItem {
  id: string;
  name: string;
  updated_at: string;
  created_at?: string;
}

export type TemplateSortBy = 'name' | 'modified' | 'created';

export const TEMPLATE_SORT_BY = ['modified', 'created', 'name'] as const satisfies readonly TemplateSortBy[];

function compareName(a: TemplateLibraryItem, b: TemplateLibraryItem): number {
  const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  if (byName !== 0) return byName;
  return a.id.localeCompare(b.id);
}

function timestamp(value: string | undefined): number {
  const parsed = Date.parse(value ?? '');
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

  const field = by === 'created' ? 'created_at' : 'updated_at';
  copy.sort((left, right) => {
    const delta = timestamp(right[field]) - timestamp(left[field]);
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
