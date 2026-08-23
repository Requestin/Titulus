import {
  classifyTemplateCapabilities as classifySharedTemplateCapabilities,
  KNOWN_TEMPLATE_CAPABILITIES,
  type TemplateCapabilityClassification,
} from '../../shared/templateCapabilities.mjs';

import type { Template, TemplateCapability } from './schema.js';

export interface TemplateCapabilitiesResult {
  schemaVersion: 'p21-capabilities-v1';
  required: TemplateCapability[];
  supported: TemplateCapability[];
  airCompatible: boolean;
}

export const TEMPLATE_CAPABILITIES = KNOWN_TEMPLATE_CAPABILITIES satisfies readonly TemplateCapability[];

/** Typed runtime facade over the shared pure classifier authority. */
export function classifyTemplateCapabilities(
  template: Template,
): TemplateCapabilitiesResult {
  return classifySharedTemplateCapabilities(template) as TemplateCapabilityClassification as TemplateCapabilitiesResult;
}
