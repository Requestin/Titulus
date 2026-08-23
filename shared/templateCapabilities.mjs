export const SUPPORTED_TEMPLATE_CAPABILITIES = Object.freeze([
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
]);

export const SUPPORTED_CAPABILITY_SET = new Set(SUPPORTED_TEMPLATE_CAPABILITIES);

export const KNOWN_TEMPLATE_CAPABILITIES = Object.freeze([
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
]);

const KNOWN_CAPABILITY_SET = new Set(KNOWN_TEMPLATE_CAPABILITIES);
const EXPANDED_VARIABLE_TYPES = new Set(['multitext', 'textfile', 'time']);
const MEDIA_MAP_TYPES = new Set(['image', 'video']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function own(value, key) {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function isBinding(value) {
  return isRecord(value) && value.type === 'variable' && typeof value.variableId === 'string';
}

function records(value) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function recordValues(value) {
  return isRecord(value) ? Object.values(value).filter(isRecord) : [];
}

function inferAnimatableValues(values, inferred) {
  if (!isRecord(values)) return;

  if (own(values, 'z')) inferred.add('properties.position-z');
  if (own(values, 'crawlProgress')) inferred.add('crawl.layer');
  if (Object.keys(values).some((property) => property.startsWith('gradient.weights.'))) {
    inferred.add('rectangle.four-corner-gradient');
  }
}

function inferTransform(transform, inferred) {
  if (own(transform, 'z')) inferred.add('properties.position-z');
}

function inferTextStyle(style, inferred) {
  if (!isRecord(style)) return;

  if (own(style, 'textTransform')) inferred.add('text.transform');
  if (own(style, 'dropShadowOffsetX') || own(style, 'dropShadowOffsetY')) {
    inferred.add('text.shadow');
  }
}

export function inferTemplateCapabilities(template) {
  const inferred = new Set();
  if (!isRecord(template)) return [];

  if (own(template, 'layerId')) inferred.add('control.layer-id-on-air');

  for (const variable of records(template.variables)) {
    if (EXPANDED_VARIABLE_TYPES.has(variable.type)
        || own(variable, 'drivenBy') || own(variable, 'exposed')) {
      inferred.add('data.expanded-variable-types');
    }
  }

  for (const group of records(template.groups)) {
    inferTransform(group.transform, inferred);
  }

  for (const layer of records(template.layers)) {
    inferTransform(layer.transform, inferred);
    inferTextStyle(layer.style, inferred);

    if (layer.type === 'crawl') inferred.add('crawl.layer');
    if (layer.type === 'rect' && (layer.fillMode === 'gradient' || own(layer, 'gradient'))) {
      inferred.add('rectangle.four-corner-gradient');
    }
    if (layer.type === 'clock' && (isBinding(layer.startTime) || isBinding(layer.targetTime))) {
      inferred.add('data.time-expressions');
    }
  }

  const data = isRecord(template.data) ? template.data : null;
  if (data) {
    if (own(data, 'sources')) inferred.add('data.sources-formats');
    if (own(data, 'pipelines') || own(data, 'runOn') || own(data, 'onError')) {
      inferred.add('data.select-map-policies');
    }

    for (const pipeline of records(data.pipelines)) {
      const maps = records(pipeline.map);
      if (own(pipeline, 'mediaResolve') || maps.some((entry) => MEDIA_MAP_TYPES.has(entry.as))) {
        inferred.add('data.media-token-resolution');
      }
      if (maps.some((entry) => entry.as === 'time')) {
        inferred.add('data.time-expressions');
      }
    }
  }

  const timeline = isRecord(template.timeline) ? template.timeline : null;
  if (timeline) {
    for (const keyframe of records(timeline.keyframes)) {
      for (const values of recordValues(keyframe.layers)) {
        inferAnimatableValues(values, inferred);
      }
      for (const values of recordValues(keyframe.groups)) {
        inferAnimatableValues(values, inferred);
      }
    }

    if (isRecord(timeline.propertyTrackDirectors)) {
      inferred.add('timeline.object-track-groups');
      for (const assignments of recordValues(timeline.propertyTrackDirectors)) {
        inferAnimatableValues(assignments, inferred);
      }
    }

    if (own(timeline, 'cues')) inferred.add('timeline.action-cues-items');
    for (const cue of records(timeline.cues)) {
      if (cue.fromEnd === true) inferred.add('timeline.action-from-end');
      for (const item of records(cue.items)) {
        if (item.command === 'stopDirectorAndWaitContinue') {
          inferred.add('timeline.continue-wait');
        }
        if (item.command === 'tag' && item.parameterTag === 'updateData') {
          inferred.add('timeline.protected-update-flow');
        }
      }
    }
  }

  return [...inferred].sort();
}

function readDeclaredCapabilities(template) {
  if (!isRecord(template) || template.capabilities === undefined) return [];
  if (!Array.isArray(template.capabilities)) {
    throw new Error('Unknown template capability declaration: capabilities must be an array');
  }

  const declared = [];
  for (const capability of template.capabilities) {
    if (typeof capability !== 'string' || !KNOWN_CAPABILITY_SET.has(capability)) {
      throw new Error('Unknown template capability declaration: ' + String(capability));
    }
    declared.push(capability);
  }
  return declared;
}

export function classifyTemplateCapabilities(template) {
  const declared = readDeclaredCapabilities(template);
  const declaredSet = new Set(declared);
  const inferred = inferTemplateCapabilities(template);
  const missing = inferred.filter((capability) => !declaredSet.has(capability));

  if (missing.length > 0) {
    throw new Error('Template capability declarations missing inferred capabilities: ' + missing.join(', '));
  }

  const required = [...new Set([...declared, ...inferred])].sort();
  const supported = [...SUPPORTED_TEMPLATE_CAPABILITIES];

  return {
    schemaVersion: 'p21-capabilities-v1',
    required,
    supported,
    airCompatible: required.every((capability) => SUPPORTED_CAPABILITY_SET.has(capability)),
  };
}

/** Write capabilities = declared ∪ inferred. Omit the field when empty. */
export function stampDeclaredCapabilities(template) {
  if (!isRecord(template)) return template;
  const inferred = inferTemplateCapabilities(template);
  const declared = Array.isArray(template.capabilities) ? template.capabilities : [];
  const required = [...new Set([...declared, ...inferred])].sort();
  if (required.length === 0) {
    delete template.capabilities;
  } else {
    template.capabilities = required;
  }
  return template;
}

