// runtime/src/schema.ts
//
// Canonical Titulus template domain model. Source of truth for the render
// layer: the engine channel page, the editor preview, and thumbnails all
// consume this (DEVELOPMENT_PROMPT §6.2). Built fresh for Phase 1 — not a copy
// of any reference; the types below mirror the requirements in §6.2 and the
// field set the editor/control plane need.
//
// Loaded inside the CEF engine page (bg-runtime.js, IIFE window.BG) and in the
// editor (ESM). No runtime dependencies — pure types + factories.

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** CSS-style blend modes supported on DOM layers (§6.2 layer types). */
export type BlendMode = 'normal' | 'multiply' | 'screen' | 'add' | 'overlay' | 'darken' | 'lighten';

/** Easing curves usable on timeline keyframes (§6.2 timeline). */
export type EasingType =
  | 'linear'
  | 'power2.in'
  | 'power2.out'
  | 'power2.inOut'
  | 'bounce.out'
  | 'elastic.out';

/**
 * Anchor-aware 2D/3D transform. `x`,`y` are canvas pixels of the layer's
 * top-left (before the anchor offset); `anchorX/Y` are a 0..1 pivot inside the
 * layer box used for rotation/scale. `perspective` (px) enables 3D rotation
 * (rotationX/rotationY) — 0 disables 3D.
 */
export interface Transform {
  x: number;
  y: number;
  /** Optional depth position. Missing preserves the legacy z=0 plane. */
  z?: number;
  width: number;
  height: number;
  rotation: number;   // degrees, Z axis
  rotationX: number;  // degrees, requires perspective > 0
  rotationY: number;  // degrees, requires perspective > 0
  perspective: number;
  scaleX: number;
  scaleY: number;
  anchorX: number;    // 0..1
  anchorY: number;    // 0..1
}

// ---------------------------------------------------------------------------
// Variables (live template data, §6.2)
// ---------------------------------------------------------------------------

/**
 * A binding replaces a literal field value with a live variable reference.
 * Any string-or-number field on a layer may be `{ type: 'variable', variableId }`.
 */
export interface VariableBinding {
  type: 'variable';
  variableId: string;
}

export type VariableType =
  | 'text'
  | 'image'
  | 'number'
  | 'color'
  | 'video'
  | 'multitext'
  | 'textfile'
  | 'time';

export interface Variable {
  id: string;
  name: string;
  label: string;
  type: VariableType;
  defaultValue: string | number;
  description?: string;
  required?: boolean;
  options?: Array<string | number>;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  /** Pipeline id that owns this variable's value. */
  drivenBy?: string;
  /** Whether Control exposes this variable to an operator. */
  exposed?: boolean;
}

// ---------------------------------------------------------------------------
// Template data pipeline (source -> parse -> select -> map -> variables)
// ---------------------------------------------------------------------------

export type DataPathRef =
  | { type: 'literal'; value: string }
  | VariableBinding;

export type DataSourceType = 'textfile' | 'jsonfile' | 'inline';
export type DataSourceFormat = 'lines' | 'delimited' | 'kv' | 'json';

export interface DataSourceOptions {
  encoding?: 'utf-8';
  skipEmpty?: boolean;
  trim?: boolean;
  commentPrefix?: string;
  delimiter?: string;
  hasHeader?: boolean;
  columns?: string[];
  kvSeparator?: string;
  /** JSON Pointer or dotted path to an object/array root. */
  rootPath?: string;
}

export interface DataSourceBase {
  id: string;
  label?: string;
  format: DataSourceFormat;
  options?: DataSourceOptions;
}

export interface InlineDataSource extends DataSourceBase {
  type: 'inline';
  content: string;
  path?: never;
}

export interface FileDataSource extends DataSourceBase {
  type: 'textfile' | 'jsonfile';
  path: DataPathRef;
  content?: never;
}

export type DataSource = InlineDataSource | FileDataSource;

export type DataSelect =
  | { mode: 'first' }
  | { mode: 'last' }
  | { mode: 'index'; index: number }
  | { mode: 'byKey'; key: string; value: string }
  | { mode: 'match'; key: string; pattern: string }
  | { mode: 'all' };

export type DataMapAs = 'text' | 'multitext' | 'number' | 'time' | 'image' | 'video';
export type DataMapTarget = VariableBinding;

export type DataValueTransform =
  | { op: 'trim' }
  | { op: 'prefix'; value: string }
  | { op: 'suffix'; value: string }
  | { op: 'replace'; pattern: string; replacement: string; flags?: string };

export interface DataMapEntry {
  from: string;
  to: DataMapTarget;
  as?: DataMapAs;
  transform?: DataValueTransform;
}

export interface DataPipelineJoin {
  field: string;
  separator?: string;
}

export type MediaResolveStrategy = 'assetId' | 'url' | 'path';
export type DataMissPolicy = 'keep' | 'clear' | 'block';

export interface MediaResolvePolicy {
  strategy: [MediaResolveStrategy, ...MediaResolveStrategy[]];
  onMiss?: DataMissPolicy;
  fallbackUrl?: string;
}

export interface DataPipeline {
  id: string;
  sourceId: string;
  enabled?: boolean;
  select: DataSelect;
  map: [DataMapEntry, ...DataMapEntry[]];
  join?: DataPipelineJoin;
  mediaResolve?: MediaResolvePolicy;
  onEmpty?: DataMissPolicy;
}

export type DataRunTrigger = 'take' | 'load' | 'update' | 'refresh';
export type DataOnError = 'block' | 'keep' | 'clear';

export interface TemplateData {
  version: 1;
  sources: DataSource[];
  pipelines: DataPipeline[];
  runOn?: DataRunTrigger[];
  onError?: DataOnError;
}

// ---------------------------------------------------------------------------
// Groups (hierarchical transforms, §6.2 groups)
// ---------------------------------------------------------------------------

export interface LayerGroup {
  id: string;
  name: string;
  parentId: string | null;
  visible: boolean;
  locked: boolean;
  transform: Transform;
}

/**
 * A root-stack entry names a top-level layer or group; its position in the
 * array defines z-order (last = frontmost).
 */
export type RootStackEntry = { kind: 'layer' | 'group'; id: string };

// ---------------------------------------------------------------------------
// Layers (§6.2 layer types table)
// ---------------------------------------------------------------------------

export interface BaseLayer {
  id: string;
  name: string;
  type: string;       // discriminator; narrowed by each subclass
  visible: boolean;
  locked: boolean;
  opacity: number;    // 0..1
  blendMode: BlendMode;
  transform: Transform;
  groupId: string | null;
}

export type TextTransformMode = 'none' | 'uppercase' | 'titlecase' | 'lowercase';

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  fill: string | VariableBinding;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  letterSpacing: number;
  strokeColor: string;
  strokeWidth: number;
  textTransform?: TextTransformMode;
  dropShadow: boolean;
  dropShadowBlur: number;
  dropShadowColor: string;
  /** Legacy single-axis shadow offset retained for old templates. */
  dropShadowDistance: number;
  dropShadowOffsetX?: number;
  dropShadowOffsetY?: number;
}

export interface TextLayer extends BaseLayer {
  type: 'text';
  content: string | VariableBinding;
  style: TextStyle;
}

export type RectFillMode = 'solid' | 'gradient';

export interface RectGradientWeights {
  topLeft: number;
  topRight: number;
  bottomLeft: number;
  bottomRight: number;
}

export interface RectGradient {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  weights: RectGradientWeights;
}

export interface RectLayerBase extends BaseLayer {
  type: 'rect';
  fill: string | VariableBinding;
  cornerRadius: number;
  borderColor: string;
  borderWidth: number;
}

export interface SolidRectLayer extends RectLayerBase {
  fillMode?: 'solid';
  gradient?: never;
}

export interface GradientRectLayer extends RectLayerBase {
  fillMode: 'gradient';
  gradient: RectGradient;
}

export type RectLayer = SolidRectLayer | GradientRectLayer;

export type ImageFit = 'stretch' | 'contain' | 'cover';

export interface ImageLayer extends BaseLayer {
  type: 'image';
  src: string | VariableBinding;
  cornerRadius: number;
  fit: ImageFit;
}

export interface VideoLayer extends BaseLayer {
  type: 'video';
  src: string | VariableBinding;
  loop: boolean;
  fit: ImageFit;
}

/**
 * Clock / timer layer (§6.2 clock). `format` is a token string like
 * "HH:mm:ss" consumed by runtime/clock.ts.
 */
export interface ClockLayer extends BaseLayer {
  type: 'clock';
  mode: 'clock' | 'countup' | 'countdown';
  format: string;
  startTime?: number;  // epoch ms (countup/countdown origin)
  targetTime?: number; // epoch ms (countdown target)
  style: TextStyle;
}

/**
 * Mask layer (§6.5 critical performance area). Implemented as a clip-path on a
 * dedicated wrapper: `maskMode: 'normal'` clips content below to the mask
 * region; `'inverted'` clips everything outside it. Single compositing layer,
 * no filter chains / backdrop-filter (§6.5 CPU-killers).
 */
export interface MaskLayer extends BaseLayer {
  type: 'mask';
  maskMode: 'normal' | 'inverted';
  shape: 'rect' | 'ellipse';
  fill: string | VariableBinding;   // informational; mask is clip-based
  cornerRadius: number;
  borderColor: string;
  borderWidth: number;
}

export type CrawlKind = 'ticker' | 'carousel';
export type CrawlHorizontalDirection = 'left' | 'right';
export type CrawlVerticalDirection = 'up' | 'down';
export type CrawlAxisDirection = CrawlHorizontalDirection | CrawlVerticalDirection;
export type CrawlSeparatorMode = 'none' | 'text' | 'image';
export type CrawlAnimationType = 'batch' | 'continuous';

interface CrawlPropsBase {
  speed: number;
  pause: number;
  separatorMode: CrawlSeparatorMode;
  separatorText: string;
  separatorImage: string;
  animationType: CrawlAnimationType;
  useFile: boolean;
  filePath: string;
  maxTextLengthEnabled: boolean;
  maxTextLength: number;
}

export type CrawlProps = CrawlPropsBase & (
  | {
    type: 'ticker';
    directionIn: CrawlHorizontalDirection;
    directionOut: CrawlHorizontalDirection;
  }
  | {
    type: 'carousel';
    directionIn: CrawlVerticalDirection;
    directionOut: CrawlVerticalDirection;
  }
);

export interface CrawlLayer extends BaseLayer {
  type: 'crawl';
  content: string | VariableBinding;
  style: TextStyle;
  crawlDirectorId: string;
  crawl: CrawlProps;
}

export type Layer =
  | TextLayer
  | RectLayer
  | ImageLayer
  | VideoLayer
  | ClockLayer
  | MaskLayer
  | CrawlLayer;

export type TemplateLayerType = Layer['type'];
/** Layer kinds currently creatable by the classic editor shell. */
export type LayerType = Exclude<TemplateLayerType, 'crawl'>;

// ---------------------------------------------------------------------------
// Timeline (frame-based, §6.2 timeline)
// ---------------------------------------------------------------------------

/**
 * Animated properties addressable from keyframes — a subset of Transform plus
 * opacity. Kept as a string-keyed bag so keyframes can target any layer/group
 * by id without a per-property field.
 */
export const ANIMATABLE_PROPS = [
  'x', 'y', 'width', 'height',
  'rotation', 'rotationX', 'rotationY', 'perspective',
  'scaleX', 'scaleY',
  'opacity',
] as const;

/** Schema-vNext properties; kept separate from legacy runtime/editor iteration. */
export const VNEXT_ANIMATABLE_PROPS = [
  'z',
  'crawlProgress',
  'gradient.weights.topLeft',
  'gradient.weights.topRight',
  'gradient.weights.bottomLeft',
  'gradient.weights.bottomRight',
] as const;

export type AnimatableProp =
  | (typeof ANIMATABLE_PROPS)[number]
  | (typeof VNEXT_ANIMATABLE_PROPS)[number];
export type AnimatableValues = Partial<Record<AnimatableProp, number>>;

/** Cubic-bezier handle for custom easing on a keyframe. */
export interface BezierHandle {
  cp1x: number;
  cp1y: number;
  cp2x: number;
  cp2y: number;
}
export const DEFAULT_BEZIER: BezierHandle = { cp1x: 0.25, cp1y: 0.1, cp2x: 0.25, cp2y: 1 };

/**
 * A keyframe holds the animated transform values for every layer/group at one
 * frame index, within the timeline. The runtime interpolates between adjacent
 * keyframes per director playhead.
 */
export interface TimelineKeyframe {
  id: string;
  frame: number;
  layers: Record<string, AnimatableValues>; // layerId -> animated values
  groups: Record<string, AnimatableValues>; // groupId -> animated values
  easing: EasingType;
  bezier?: BezierHandle;
}

/**
 * A director is a named sub-sequence of the timeline with its own duration and
 * play rules (§6.2 directors).
 */
export interface TimelineDirector {
  id: string;
  name: string;
  durationFrames: number;
  offsetFrames: number;
  autostart: boolean;
  loop: boolean;
  swing: boolean;   // ping-pong: reverse on each loop iteration
}

export type TimelineActionCommand = 'startDirector' | 'stopDirector' | 'setTag';
export type TimelineActionTag = 'Stop' | 'End scene';
export const TIMELINE_ACTION_TAGS: TimelineActionTag[] = ['Stop', 'End scene'];

/** A cue point that fires a command when the playhead crosses its frame. */
export interface TimelineAction {
  id: string;
  directorId: string;
  frame: number;
  command: TimelineActionCommand;
  targetDirectorId: string | null;  // for start/stop director
  tag: TimelineActionTag | null;    // for setTag
}

export type TimelineCueCommand =
  | 'startDirector'
  | 'stopDirector'
  | 'stopDirectorAndWaitContinue'
  | 'pauseDirector'
  | 'tag';
export type TimelineCueDirection = 'normal' | 'reverse' | 'both';
export type TimelineCueTag = 'endScene' | 'updateData';

export type TimelineCueDirectorCommand = Exclude<TimelineCueCommand, 'tag'>;

export interface TimelineCueItemBase {
  id: string;
  lengthFrames: number;
  direction: TimelineCueDirection;
}

export interface TimelineDirectorCueItem extends TimelineCueItemBase {
  command: TimelineCueDirectorCommand;
  parameterDirectorId: string;
  parameterTag?: never;
}

export interface TimelineTagCueItem extends TimelineCueItemBase {
  command: 'tag';
  parameterTag: TimelineCueTag;
  parameterDirectorId?: never;
}

export type TimelineCueItem = TimelineDirectorCueItem | TimelineTagCueItem;

export interface TimelineCue {
  id: string;
  directorId: string;
  frame: number;
  fromEnd: boolean;
  name: string;
  items: [TimelineCueItem, ...TimelineCueItem[]];
}

export type PlaybackMode = 'bounded' | 'infinite';

export interface Timeline {
  fps: number;
  /** Last playable frame (inclusive). With 100, frames 0..100 are addressable. */
  durationFrames: number;
  playbackMode: PlaybackMode;
  directors: TimelineDirector[];
  /** layerId|groupId -> the director that animates it. */
  trackDirectors: Record<string, string>;
  keyframes: TimelineKeyframe[];
  /** Legacy single-command action path; remains required and unchanged. */
  actions: TimelineAction[];
  /** Additive multi-item action-cue path. */
  cues?: TimelineCue[];
  /** target id -> animated property -> director id. */
  propertyTrackDirectors?: Record<string, Partial<Record<AnimatableProp, string>>>;
}

// ---------------------------------------------------------------------------
// Template (top-level)
// ---------------------------------------------------------------------------

export interface Canvas {
  width: number;
  height: number;
  background: string;  // 'transparent' | '#rrggbb' | css color
}

export interface TemplateMetadata {
  category?: string;
  locale?: string;
  safeTitle?: string;
  notes?: string;
}

export type TemplateCapability =
  | 'control.layer-id-on-air'
  | 'crawl.layer'
  | 'data.expanded-variable-types'
  | 'data.media-token-resolution'
  | 'data.select-map-policies'
  | 'data.sources-formats'
  | 'data.time-expressions'
  | 'properties.position-z'
  | 'rectangle.four-corner-gradient'
  | 'text.shadow'
  | 'text.transform'
  | 'timeline.action-cues-items'
  | 'timeline.action-from-end'
  | 'timeline.continue-wait'
  | 'timeline.object-track-groups'
  | 'timeline.protected-update-flow';

export interface Template {
  schemaVersion?: string;
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  metadata?: TemplateMetadata;
  /** Explicit schema-vNext capabilities required by this template. */
  capabilities?: TemplateCapability[];
  /** Cross-template playout stack rank; valid serialized values are 1..99. */
  layerId?: number;
  canvas: Canvas;
  variables: Variable[];
  /** Designer-owned data pipeline. Missing preserves legacy behavior. */
  data?: TemplateData;
  groups: LayerGroup[];
  layers: Layer[];
  rootStack: RootStackEntry[];
  /** Per-group child ordering (groupId -> entries). */
  groupStacks: Record<string, RootStackEntry[]>;
  timeline: Timeline;
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function randomUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback (older runtimes / non-secure context).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function createDefaultTransform(x = 100, y = 100): Transform {
  return {
    x,
    y,
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
  };
}

export function createDefaultTimeline(): Timeline {
  const defaultDirector: TimelineDirector = {
    id: 'default',
    name: 'default',
    durationFrames: 500,
    offsetFrames: 0,
    autostart: true,
    loop: false,
    swing: false,
  };
  return {
    fps: 50,
    durationFrames: 500,
    playbackMode: 'bounded',
    directors: [defaultDirector],
    trackDirectors: {},
    keyframes: [],
    actions: [],
  };
}

export function createDefaultTemplate(): Template {
  return {
    id: randomUUID(),
    name: 'Untitled',
    canvas: { width: 1920, height: 1080, background: 'transparent' },
    variables: [],
    groups: [],
    layers: [],
    rootStack: [],
    groupStacks: {},
    timeline: createDefaultTimeline(),
  };
}

// ---------------------------------------------------------------------------
// Variable-binding resolution helper (shared by renderer + editor)
// ---------------------------------------------------------------------------

/** Resolve a field that may be a literal or a `{type:'variable'}` binding. */
export function resolveBinding(
  field: string | number | VariableBinding | undefined,
  variables: Record<string, string | number>,
  fallback: string | number = '',
): string | number {
  if (field === undefined || field === null) return fallback;
  if (typeof field === 'object') {
    // VariableBinding — resolve via the variable map, or fall back.
    return variables[field.variableId] ?? fallback;
  }
  return field;
}

/** Build a `variableId -> value` map from a Template's variables + overrides. */
export function resolveVariableMap(
  template: Pick<Template, 'variables'>,
  overrides: Record<string, string | number> = {},
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const v of template.variables) out[v.id] = v.defaultValue;
  Object.assign(out, overrides);
  return out;
}
