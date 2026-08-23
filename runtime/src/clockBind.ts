import { parseTimeExpression } from '../../shared/timeExpressions.mjs';
import type { VariableBinding } from './schema.js';

export type ClockAnchor = number | VariableBinding | undefined;

export function resolveClockAnchor(
  field: ClockAnchor,
  variables: Record<string, string | number>,
  nowMs: number,
): number | undefined {
  if (field == null) return undefined;
  if (typeof field === 'number') return field;
  if (typeof field === 'object' && field.type === 'variable') {
    const raw = variables[field.variableId];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    return parseTimeExpression(raw, nowMs);
  }
  return undefined;
}
