import { createHash } from 'node:crypto';

const ACTION_CUES_CAPABILITY = 'timeline.action-cues-items';

export class TemplateMigrationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TemplateMigrationError';
    this.code = code;
    this.details = details;
  }
}

function stableId(prefix, value) {
  const digest = createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 16);
  return `${prefix}-${digest}`;
}

function uniqueId(base, usedIds) {
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function migrateActionItem(action, sourceIndex) {
  const id = typeof action.id === 'string' && action.id.length > 0
    ? action.id
    : stableId('legacy-action-item', [sourceIndex, action]);
  const common = {
    id,
    lengthFrames: 0,
    direction: 'normal',
  };

  if (action.command === 'startDirector' || action.command === 'stopDirector') {
    return {
      ...common,
      command: action.command,
      parameterDirectorId: action.targetDirectorId,
    };
  }

  if (action.command === 'setTag') {
    if (action.tag === 'Stop') {
      throw new TemplateMigrationError(
        'AMBIGUOUS_LEGACY_STOP_TAG',
        'Legacy tag "Stop" is ambiguous and cannot be migrated safely',
        { actionId: action.id ?? null },
      );
    }
    return {
      ...common,
      command: 'tag',
      parameterTag: action.tag === 'End scene' ? 'endScene' : action.tag,
    };
  }

  // Preserve an invalid command for schema validation instead of silently
  // discarding an unknown legacy action.
  return {
    ...common,
    command: action.command,
    parameterDirectorId: action.targetDirectorId,
  };
}

function addActionCuesCapability(template) {
  const capabilities = Array.isArray(template.capabilities)
    ? template.capabilities
    : [];
  template.capabilities = [...new Set([
    ...capabilities,
    ACTION_CUES_CAPABILITY,
  ])].sort();
}

/**
 * Return a detached canonical template value.
 *
 * Legacy flat actions are grouped by their first-seen director/frame pair.
 * Both cue order and item order therefore follow the original actions array.
 */
export function migrateTemplate(template) {
  const migrated = structuredClone(template);
  const timeline = migrated?.timeline;
  const actions = timeline?.actions;
  const capabilities = Array.isArray(migrated?.capabilities)
    ? migrated.capabilities
    : [];

  // Legacy templates stay on the classic action path until they explicitly
  // opt into canonical cues. This prevents a read/save boundary from replacing
  // current behavior with an air-unsupported contract.
  if (!capabilities.includes(ACTION_CUES_CAPABILITY)) {
    return migrated;
  }
  if (!Array.isArray(actions) || actions.length === 0) {
    return migrated;
  }
  if (timeline.cues !== undefined && !Array.isArray(timeline.cues)) {
    return migrated;
  }

  const groups = new Map();
  actions.forEach((action, sourceIndex) => {
    const directorId = action?.directorId;
    const frame = action?.frame;
    const key = JSON.stringify([directorId, frame]);
    let group = groups.get(key);
    if (!group) {
      group = { directorId, frame, actions: [] };
      groups.set(key, group);
    }
    group.actions.push({ action: action ?? {}, sourceIndex });
  });

  const existingCues = Array.isArray(timeline.cues) ? timeline.cues : [];
  const usedCueIds = new Set(
    existingCues
      .map((cue) => cue?.id)
      .filter((id) => typeof id === 'string'),
  );
  const migratedCues = [];

  for (const group of groups.values()) {
    const baseId = stableId('legacy-action-cue', [group.directorId, group.frame]);
    migratedCues.push({
      id: uniqueId(baseId, usedCueIds),
      directorId: group.directorId,
      frame: group.frame,
      fromEnd: false,
      name: `Legacy actions: ${String(group.directorId)} @ frame ${String(group.frame)}`,
      items: group.actions.map(({ action, sourceIndex }) =>
        migrateActionItem(action, sourceIndex)),
    });
  }

  timeline.actions = [];
  timeline.cues = [...existingCues, ...migratedCues];
  addActionCuesCapability(migrated);
  return migrated;
}
