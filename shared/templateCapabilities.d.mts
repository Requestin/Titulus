export const SUPPORTED_TEMPLATE_CAPABILITIES: readonly string[];
export const SUPPORTED_CAPABILITY_SET: ReadonlySet<string>;

export const KNOWN_TEMPLATE_CAPABILITIES: readonly [
  'control.layer-id-on-air',
  'crawl.layer',
  'data.expanded-variable-types',
  'data.media-token-resolution',
  'data.select-map-policies',
  'data.sources-formats',
  'data.time-expressions',
  'properties.position-z',
  'rectangle.four-corner-gradient',
  'text.shadow',
  'text.transform',
  'timeline.action-cues-items',
  'timeline.action-from-end',
  'timeline.continue-wait',
  'timeline.object-track-groups',
  'timeline.protected-update-flow',
];

export type KnownTemplateCapability = (typeof KNOWN_TEMPLATE_CAPABILITIES)[number];

export interface TemplateCapabilityClassification {
  schemaVersion: 'p21-capabilities-v1';
  required: KnownTemplateCapability[];
  supported: KnownTemplateCapability[];
  airCompatible: boolean;
}

export function classifyTemplateCapabilities(
  template: unknown,
): TemplateCapabilityClassification;

export function inferTemplateCapabilities(template: unknown): KnownTemplateCapability[];
export function stampDeclaredCapabilities<T>(template: T): T;
