import type { Template, TemplateCapability } from './schema.js';

function cloneTemplate(template: Template): Template {
  if (typeof structuredClone === 'function') return structuredClone(template);
  return JSON.parse(JSON.stringify(template)) as Template;
}

/**
 * Produce a detached, deterministic template value without schema migration or
 * render-time interpretation. Optional legacy fields remain absent.
 */
export function normalizeTemplate(template: Template): Template {
  const normalized = cloneTemplate(template);

  if (normalized.capabilities !== undefined) {
    normalized.capabilities = [...new Set<TemplateCapability>(normalized.capabilities)].sort();
  }

  return normalized;
}
