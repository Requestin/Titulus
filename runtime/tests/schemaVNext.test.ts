import {
  createDefaultTemplate,
  createDefaultTransform,
  type Layer,
  type RectLayer,
  type Template,
  type TextStyle,
  type Timeline,
  type Transform,
  type Variable,
} from '../src/schema.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertJsonEqual(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}\nexpected: ${expectedJson}\nactual:   ${actualJson}`);
  }
}

const templateWithCapabilities = {
  ...createDefaultTemplate(),
  capabilities: ['crawl.layer', 'data.sources-formats'],
} satisfies Template;

const transformWithZ = {
  ...createDefaultTransform(),
  z: 120,
} satisfies Transform;

const textStyleVNext = {
  fontFamily: 'Inter',
  fontSize: 48,
  fontWeight: '600',
  fill: '#ffffff',
  align: 'left',
  lineHeight: 1.1,
  letterSpacing: 0,
  strokeColor: '#000000',
  strokeWidth: 0,
  textTransform: 'uppercase',
  dropShadow: true,
  dropShadowBlur: 6,
  dropShadowColor: '#000000',
  dropShadowDistance: 2,
  dropShadowOffsetX: 4,
  dropShadowOffsetY: 6,
} satisfies TextStyle;

const gradientLayerVNext = {
  id: 'gradient',
  name: 'Gradient',
  type: 'rect',
  visible: true,
  locked: false,
  opacity: 1,
  blendMode: 'normal',
  transform: createDefaultTransform(),
  groupId: null,
  fill: '#1f2937',
  fillMode: 'gradient',
  gradient: {
    topLeft: '#ef4444',
    topRight: '#3b82f6',
    bottomLeft: '#22c55e',
    bottomRight: '#eab308',
    weights: {
      topLeft: 100,
      topRight: 80,
      bottomLeft: 60,
      bottomRight: 40,
    },
  },
  cornerRadius: 8,
  borderColor: '#000000',
  borderWidth: 0,
} satisfies RectLayer;

const crawlLayerVNext = {
  id: 'crawl',
  name: 'Crawl',
  type: 'crawl',
  visible: true,
  locked: false,
  opacity: 1,
  blendMode: 'normal',
  transform: createDefaultTransform(),
  groupId: null,
  content: 'First item\nSecond item',
  style: textStyleVNext,
  crawlDirectorId: 'crawl-director',
  crawl: {
    type: 'ticker',
    directionIn: 'right',
    directionOut: 'left',
    speed: 5,
    pause: 0,
    separatorMode: 'text',
    separatorText: ' • ',
    separatorImage: '',
    animationType: 'continuous',
    useFile: false,
    filePath: '',
    maxTextLengthEnabled: false,
    maxTextLength: 80,
  },
} satisfies Layer;

const expandedVariables = [
  {
    id: 'multi',
    name: 'multi',
    label: 'Multi text',
    type: 'multitext',
    defaultValue: 'one\ntwo',
    drivenBy: 'pipeline',
    exposed: false,
  },
  {
    id: 'file',
    name: 'file',
    label: 'Text file',
    type: 'textfile',
    defaultValue: '/data/headlines.txt',
    exposed: true,
  },
  {
    id: 'time',
    name: 'time',
    label: 'Time',
    type: 'time',
    defaultValue: 'now+30m',
  },
] satisfies Variable[];

const templateWithData = {
  ...createDefaultTemplate(),
  data: {
    version: 1,
    sources: [{
      id: 'source',
      type: 'inline',
      content: 'title=Phase 21',
      format: 'kv',
      options: { kvSeparator: '=', trim: true },
    }],
    pipelines: [{
      id: 'pipeline',
      sourceId: 'source',
      select: { mode: 'first' },
      map: [{
        from: 'title',
        to: { type: 'variable', variableId: 'multi' },
        as: 'multitext',
        transform: { op: 'trim' },
      }],
      onEmpty: 'keep',
    }],
    runOn: ['take', 'update'],
    onError: 'block',
  },
} satisfies Template;

const timelineWithCues = {
  ...createDefaultTemplate().timeline,
  actions: [],
  cues: [{
    id: 'pause-cue',
    directorId: 'default',
    frame: 50,
    fromEnd: false,
    name: 'Pause default',
    items: [{
      id: 'pause-item',
      command: 'pauseDirector',
      parameterDirectorId: 'default',
      lengthFrames: 20,
      direction: 'both',
    }],
  }],
} satisfies Timeline;

const timelineWithPropertyTrackDirectors = {
  ...createDefaultTemplate().timeline,
  propertyTrackDirectors: {
    gradient: {
      z: 'default',
      rotation: 'default',
      scaleX: 'default',
    },
  },
} satisfies Timeline;

const templateWithLayerId = {
  ...createDefaultTemplate(),
  layerId: 42,
} satisfies Template;

const typedVNextExamples = {
  templateWithCapabilities,
  transformWithZ,
  textStyleVNext,
  gradientLayerVNext,
  crawlLayerVNext,
  expandedVariables,
  templateWithData,
  timelineWithCues,
  timelineWithPropertyTrackDirectors,
  templateWithLayerId,
};

assert(typedVNextExamples.transformWithZ.z === 120, 'typed Transform.z example was lost');
assert(typedVNextExamples.expandedVariables.length === 3, 'expanded variable examples were lost');
assert(typedVNextExamples.timelineWithCues.actions.length === 0, 'classic actions path must remain empty');
assert(typedVNextExamples.timelineWithCues.cues.length === 1, 'canonical cue example was lost');

const defaultTransform = createDefaultTransform();
assertJsonEqual(defaultTransform, {
  x: 100,
  y: 100,
  width: 300,
  height: 80,
  rotation: 0,
  rotationX: 0,
  rotationY: 0,
  perspective: 1000,
  scaleX: 1,
  scaleY: 1,
  anchorX: 0,
  anchorY: 0,
}, 'createDefaultTransform must preserve the legacy serialized shape');
assert(!('z' in defaultTransform), 'createDefaultTransform must not materialize optional z');

const defaultTemplate = createDefaultTemplate();
const { id, ...defaultTemplateWithoutId } = defaultTemplate;
assert(typeof id === 'string' && id.length > 0, 'default template must have an id');
assertJsonEqual(defaultTemplateWithoutId, {
  name: 'Untitled',
  canvas: { width: 1920, height: 1080, background: 'transparent' },
  variables: [],
  groups: [],
  layers: [],
  rootStack: [],
  groupStacks: {},
  timeline: {
    fps: 50,
    durationFrames: 500,
    playbackMode: 'bounded',
    directors: [{
      id: 'default',
      name: 'default',
      durationFrames: 500,
      offsetFrames: 0,
      autostart: true,
      loop: false,
      swing: false,
    }],
    trackDirectors: {},
    keyframes: [],
    actions: [],
  },
}, 'createDefaultTemplate must preserve the legacy serialized shape');
for (const optionalField of ['capabilities', 'data', 'layerId']) {
  assert(!(optionalField in defaultTemplate), `createDefaultTemplate must not materialize ${optionalField}`);
}
for (const optionalField of ['cues', 'propertyTrackDirectors']) {
  assert(
    !(optionalField in defaultTemplate.timeline),
    `createDefaultTemplate must not materialize timeline.${optionalField}`,
  );
}
