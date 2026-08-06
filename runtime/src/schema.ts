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
 * layer box used for rotation/scale. `z` is CSS `translateZ` (px) for 2.5D
 * depth separation. `perspective` (px) enables 3D rotation (rotationX/Y);
 * 0 disables perspective on the element (parent may still provide it).
 */
export interface Transform {
  x: number;
  y: number;
  /** CSS translateZ in px — separates tilted planes in a preserve-3d scene. */
  z: number;
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

export type VariableType = 'text' | 'image' | 'number' | 'color' | 'video' | 'multitext' | 'textfile' | 'time';

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
  /**
   * Pipeline id that owns this variable (`template.data.pipelines[].id`).
   * Editor/Control should treat the value as derived when set.
   */
  drivenBy?: string;
  /**
   * When false, Control must not show this variable. Default true.
   * Driven variables typically set `exposed: false`.
   */
  exposed?: boolean;
}

// ---------------------------------------------------------------------------
// Template data pipeline (file → parse → select → map → variables)
// Declarative, designer-owned; Control does not pick rows.
// ---------------------------------------------------------------------------

/** How to locate a data file path. */
export type DataPathRef =
  | { type: 'literal'; value: string }
  | { type: 'variable'; variableId: string };

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
  /** JSON Pointer or dotted path to array/object root. Empty = whole document. */
  rootPath?: string;
}

export interface DataSource {
  id: string;
  label?: string;
  type: DataSourceType;
  /** Required for textfile/jsonfile. */
  path?: DataPathRef;
  /** Required for inline. */
  content?: string;
  format: DataSourceFormat;
  options?: DataSourceOptions;
}

export type DataSelect =
  | { mode: 'first' }
  | { mode: 'last' }
  | { mode: 'index'; index: number }
  | { mode: 'byKey'; key: string; value: string }
  | { mode: 'match'; key: string; pattern: string }
  | { mode: 'all' };

export type DataMapAs = 'text' | 'number' | 'image' | 'video' | 'multitext' | 'time';

export type DataMapTarget = { type: 'variable'; variableId: string };

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

export type MediaResolveStrategy = 'assetId' | 'url' | 'path';
export type DataMissPolicy = 'keep' | 'clear' | 'block';

export interface MediaResolvePolicy {
  strategy: MediaResolveStrategy[];
  onMiss?: DataMissPolicy;
  fallbackUrl?: string;
}

export interface DataPipelineJoin {
  field: string;
  separator?: string;
}

export interface DataPipeline {
  id: string;
  sourceId: string;
  enabled?: boolean;
  select: DataSelect;
  map: DataMapEntry[];
  join?: DataPipelineJoin;
  mediaResolve?: MediaResolvePolicy;
  onEmpty?: DataMissPolicy;
}

export type DataRunTrigger = 'take' | 'update' | 'load' | 'refresh';
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

/**
 * Case transform applied to resolved text content (literal or variable).
 * - `none` — leave as-is
 * - `uppercase` — all caps
 * - `titlecase` — first letter of each word upper, rest lower
 * - `lowercase` — all lower
 */
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
  /** Case transform for rendered text content. Default `none`. */
  textTransform?: TextTransformMode;
  dropShadow: boolean;
  dropShadowBlur: number;
  dropShadowColor: string;
  /** Shadow offset X in px. Default 1. */
  dropShadowOffsetX?: number;
  /** Shadow offset Y in px. Default 1. */
  dropShadowOffsetY?: number;
  /**
   * @deprecated Legacy single-axis offset (treated as Y, X=0). Prefer
   * dropShadowOffsetX/Y. Kept optional for soft-migration of old templates.
   */
  dropShadowDistance?: number;
}

export interface TextLayer extends BaseLayer {
  type: 'text';
  content: string | VariableBinding;
  style: TextStyle;
}

export interface RectLayer extends BaseLayer {
  type: 'rect';
  fill: string | VariableBinding;
  /** Solid fill (default) or 4-corner gradient. */
  fillMode?: 'solid' | 'gradient';
  /** Corner colors + weights (0–100). Used when `fillMode === 'gradient'`. */
  gradient?: RectGradient;
  cornerRadius: number;
  borderColor: string;
  borderWidth: number;
}

/** One corner of a rectangle gradient (VizArtist-style). */
export interface RectGradientCorner {
  color: string;
  /** Corner fill strength 0–100 (100 = maximum). */
  value: number;
}

export interface RectGradient {
  upperLeft: RectGradientCorner;
  lowerLeft: RectGradientCorner;
  upperRight: RectGradientCorner;
  lowerRight: RectGradientCorner;
}

export function defaultRectGradient(): RectGradient {
  return {
    upperLeft: { color: '#ff0000', value: 100 },
    lowerLeft: { color: '#f5f5f5', value: 100 },
    upperRight: { color: '#0000ff', value: 100 },
    lowerRight: { color: '#00ff00', value: 100 },
  };
}

/** Animatable corner-weight prop names (timeline tracks). */
export const RECT_GRADIENT_PROPS = [
  'UpperLeft',
  'LowerLeft',
  'UpperRight',
  'LowerRight',
] as const;
export type RectGradientProp = (typeof RECT_GRADIENT_PROPS)[number];

export function isRectGradientProp(prop: string): prop is RectGradientProp {
  return (RECT_GRADIENT_PROPS as readonly string[]).includes(prop);
}

function clampCornerPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/**
 * VizArtist-style 4-corner fill (opaque).
 * Corner `value` 0–100 scales that corner's weight in a bilinear blend.
 * Uses an SVG data-URI so the fill stays fully opaque at opacity=1.
 */
export function rectCornerGradientCss(
  g: RectGradient,
  overrides?: Partial<Record<RectGradientProp, number>>,
): string {
  const ulV = clampCornerPct(overrides?.UpperLeft ?? g.upperLeft.value) / 100;
  const llV = clampCornerPct(overrides?.LowerLeft ?? g.lowerLeft.value) / 100;
  const urV = clampCornerPct(overrides?.UpperRight ?? g.upperRight.value) / 100;
  const lrV = clampCornerPct(overrides?.LowerRight ?? g.lowerRight.value) / 100;

  const ul = weightedCornerColor(g.upperLeft.color, ulV);
  const ur = weightedCornerColor(g.upperRight.color, urV);
  const ll = weightedCornerColor(g.lowerLeft.color, llV);
  const lr = weightedCornerColor(g.lowerRight.color, lrV);

  // Opaque bilinear: top row UL→UR, bottom LL→LR, vertical mask blend.
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" preserveAspectRatio="none">` +
    `<defs>` +
    `<linearGradient id="t" x1="0" y1="0" x2="1" y2="0">` +
    `<stop offset="0" stop-color="${ul}"/><stop offset="1" stop-color="${ur}"/>` +
    `</linearGradient>` +
    `<linearGradient id="b" x1="0" y1="0" x2="1" y2="0">` +
    `<stop offset="0" stop-color="${ll}"/><stop offset="1" stop-color="${lr}"/>` +
    `</linearGradient>` +
    `<linearGradient id="v" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/>` +
    `</linearGradient>` +
    `<mask id="m"><rect width="100%" height="100%" fill="url(#v)"/></mask>` +
    `</defs>` +
    `<rect width="100%" height="100%" fill="url(#b)"/>` +
    `<rect width="100%" height="100%" fill="url(#t)" mask="url(#m)"/>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** Mix corner toward a neutral gray by (1 - weight); stays opaque. */
function weightedCornerColor(hex: string, weight: number): string {
  const w = Math.max(0, Math.min(1, weight));
  const c = parseHexColor(hex) ?? { r: 128, g: 128, b: 128 };
  // weight 1 → full corner color; 0 → mid gray (no contribution / neutral fill)
  const r = Math.round(c.r * w + 128 * (1 - w));
  const g = Math.round(c.g * w + 128 * (1 - w));
  const b = Math.round(c.b * w + 128 * (1 - w));
  return `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`;
}

function parseHexColor(input: string): { r: number; g: number; b: number } | null {
  const s = input.trim();
  const m6 = /^#([0-9a-fA-F]{6})$/.exec(s);
  if (m6) {
    const n = Number.parseInt(m6[1]!, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const m3 = /^#([0-9a-fA-F]{3})$/.exec(s);
  if (m3) {
    const h = m3[1]!;
    return {
      r: Number.parseInt(h[0]! + h[0]!, 16),
      g: Number.parseInt(h[1]! + h[1]!, 16),
      b: Number.parseInt(h[2]! + h[2]!, 16),
    };
  }
  return null;
}

function toHex2(n: number): string {
  return Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
}

export type ImageFit = 'stretch' | 'contain' | 'cover';

export interface ImageLayer extends BaseLayer {
  type: 'image';
  src: string | VariableBinding;
  cornerRadius: number;
  fit: ImageFit;
}

/** What the renderer shows after a non-looping clip finishes. */
export type VideoEndBehavior = 'lastFrame' | 'empty';

export interface VideoLayer extends BaseLayer {
  type: 'video';
  src: string | VariableBinding;
  loop: boolean;
  fit: ImageFit;
  /**
   * After the timeline clip window ends (non-loop): keep last frame or hide.
   * Soft-default `lastFrame` for older templates.
   */
  endBehavior?: VideoEndBehavior;
  /** Source duration in timeline frames (template fps). Used for clip bar length. */
  durationFrames?: number;
}

/**
 * Clock / timer layer (§6.2 clock). `format` is a token string like
 * "HH:mm:ss" consumed by runtime/clock.ts.
 *
 * `startTime` / `targetTime` may be a literal epoch ms or a binding to a
 * `time` variable (operator expression like `today+1@20:00` — see timeExpr.ts).
 */
export interface ClockLayer extends BaseLayer {
  type: 'clock';
  mode: 'clock' | 'countup' | 'countdown';
  format: string;
  startTime?: number | VariableBinding;
  targetTime?: number | VariableBinding;
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
export type CrawlAxisDir = 'left' | 'right' | 'up' | 'down';
export type CrawlSeparatorMode = 'none' | 'text' | 'image';
export type CrawlAnimationType = 'batch' | 'continuous';

export interface CrawlProps {
  type: CrawlKind;
  directionIn: CrawlAxisDir;
  directionOut: CrawlAxisDir;
  /** 1 = 60 px/s. Default 5. */
  speed: number;
  /** Hold frames when a line is fully on screen. Default 0. */
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

export type LayerType = Layer['type'];

// ---------------------------------------------------------------------------
// Timeline (frame-based, §6.2 timeline)
// ---------------------------------------------------------------------------

/**
 * Animated properties addressable from keyframes — a subset of Transform plus
 * opacity. Kept as a string-keyed bag so keyframes can target any layer/group
 * by id without a per-property field.
 */
export const ANIMATABLE_PROPS = [
  'x', 'y', 'z', 'width', 'height',
  'rotation', 'rotationX', 'rotationY', 'perspective',
  'scaleX', 'scaleY',
  'opacity',
  /** Crawl scroll progress 0..1 (dedicated Crawl director track). */
  'crawlProgress',
  /** Video clip progress 0..1 over source duration (default-director clip track). */
  'videoProgress',
  /** Rect gradient corner weights 0..100 (when fillMode=gradient). */
  'UpperLeft',
  'LowerLeft',
  'UpperRight',
  'LowerRight',
] as const;
export type AnimatableProp = (typeof ANIMATABLE_PROPS)[number];
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

export type TimelineActionCommand =
  | 'startDirector'
  | 'stopDirector'
  | 'stopDirectorAndWaitContinue'
  | 'pauseDirector'
  | 'tag';

export type TimelineActionDirection = 'both' | 'normal' | 'reverse';

/** Tag parameters for command `tag`. */
export type TimelineActionTag = 'endScene' | 'updateData';

export const TIMELINE_ACTION_COMMANDS: TimelineActionCommand[] = [
  'startDirector',
  'stopDirector',
  'stopDirectorAndWaitContinue',
  'pauseDirector',
  'tag',
];

export const TIMELINE_ACTION_DIRECTIONS: TimelineActionDirection[] = ['both', 'normal', 'reverse'];
export const TIMELINE_ACTION_TAGS: TimelineActionTag[] = ['endScene', 'updateData'];

/** Reserved director name for Update-flow (case-insensitive match). */
export const UPDATE_DIRECTOR_NAME = 'Update';

/** One command inside a timeline action cue (marker). */
export interface TimelineActionItem {
  id: string;
  command: TimelineActionCommand | null;
  parameterDirectorId?: string | null;
  parameterTag?: TimelineActionTag | null;
  lengthFrames: number;
  direction: TimelineActionDirection;
}

/**
 * One visual marker on a director timeline at `frame`.
 * May contain N command items executed in array order when the playhead crosses.
 *
 * When `fromEnd` is true, `frame` is an offset from the director end
 * (effective = durationFrames - frame). Legacy cues omit `fromEnd` (= absolute).
 */
export interface TimelineActionCue {
  id: string;
  directorId: string;
  frame: number;
  /** If true, `frame` is frames-before-end of the host director. */
  fromEnd?: boolean;
  name: string;
  items: TimelineActionItem[];
}

/** Resolve cue marker to an absolute local frame on its host director. */
export function effectiveActionFrame(
  cue: Pick<TimelineActionCue, 'frame' | 'fromEnd'>,
  durationFrames: number,
): number {
  const dur = Math.max(0, Math.round(durationFrames));
  const raw = Math.max(0, Math.round(cue.frame));
  if (!cue.fromEnd) return Math.min(raw, dur);
  return Math.max(0, dur - raw);
}

/** Store value for `frame` given an absolute drop position and fromEnd mode. */
export function actionFrameFromEffective(
  effectiveFrame: number,
  durationFrames: number,
  fromEnd: boolean | undefined,
): number {
  const dur = Math.max(0, Math.round(durationFrames));
  const eff = Math.max(0, Math.min(dur, Math.round(effectiveFrame)));
  if (!fromEnd) return eff;
  return Math.max(0, dur - eff);
}

/** @deprecated Use TimelineActionCue — kept as alias during editor migration. */
export type TimelineAction = TimelineActionCue;

export type PlaybackMode = 'bounded' | 'infinite';

export interface Timeline {
  fps: number;
  /** Last playable frame (inclusive). With 100, frames 0..100 are addressable. */
  durationFrames: number;
  playbackMode: PlaybackMode;
  directors: TimelineDirector[];
  /**
   * Track -> director. Keys are `layer:<id>:<prop>` / `group:<id>:<prop>`.
   * Legacy templates may still use bare layer/group ids (all props on that target).
   */
  trackDirectors: Record<string, string>;
  /** Optional display order of track keys per director (see timelineTrackKey). */
  trackOrder?: Record<string, string[]>;
  keyframes: TimelineKeyframe[];
  actions: TimelineActionCue[];
}

/** Stable key for one animated property track in the editor / trackDirectors map. */
export function timelineTrackKey(
  target: { kind: 'layer' | 'group'; id: string },
  prop: AnimatableProp,
): string {
  return `${target.kind}:${target.id}:${prop}`;
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

/** Default cross-template playout stack rank (1 = frontmost, 99 = backmost). */
export const DEFAULT_TEMPLATE_LAYER_ID = 50;

/** Clamp / default template layerId for playout stacking. */
export function normalizeTemplateLayerId(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_TEMPLATE_LAYER_ID;
  return Math.min(99, Math.max(1, Math.round(n)));
}

export interface Template {
  schemaVersion?: string;
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  metadata?: TemplateMetadata;
  /**
   * Cross-template playout stack on a channel (1–99). Smaller paints above.
   * Missing → treat as {@link DEFAULT_TEMPLATE_LAYER_ID}.
   */
  layerId?: number;
  canvas: Canvas;
  variables: Variable[];
  /**
   * Optional designer-owned data pipeline (file → variables).
   * Absent = legacy template with no internal data binding.
   */
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
    z: 0,
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

export function isUpdateDirectorName(name: string): boolean {
  return name.trim().toLowerCase() === UPDATE_DIRECTOR_NAME.toLowerCase();
}

export function createUpdateDirector(id?: string): TimelineDirector {
  return {
    id: id ?? randomUUID(),
    name: UPDATE_DIRECTOR_NAME,
    durationFrames: 100,
    offsetFrames: 0,
    autostart: false,
    loop: false,
    swing: false,
  };
}

export function createDefaultActionItem(partial?: Partial<TimelineActionItem>): TimelineActionItem {
  return {
    id: partial?.id ?? randomUUID(),
    command: partial?.command ?? null,
    parameterDirectorId: partial?.parameterDirectorId ?? null,
    parameterTag: partial?.parameterTag ?? null,
    lengthFrames: partial?.lengthFrames ?? 0,
    direction: partial?.direction ?? 'both',
  };
}

export function createUpdateDataCue(directorId: string, durationFrames = 100): TimelineActionCue {
  const mid = Math.max(0, Math.floor(durationFrames / 2));
  return {
    id: randomUUID(),
    directorId,
    frame: mid,
    name: '',
    items: [
      createDefaultActionItem({
        command: 'tag',
        parameterTag: 'updateData',
        direction: 'both',
      }),
    ],
  };
}

/** Ensure template has protected Update director + single Update data tag cue. Mutates timeline. */
export function ensureUpdateDirector(timeline: Timeline): void {
  let update = timeline.directors.find((d) => isUpdateDirectorName(d.name));
  if (!update) {
    update = createUpdateDirector();
    timeline.directors.push(update);
  } else {
    update.name = UPDATE_DIRECTOR_NAME;
  }

  const updateDataCues = timeline.actions.filter((cue) =>
    cue.items.some((it) => it.command === 'tag' && it.parameterTag === 'updateData'),
  );
  const onUpdate = updateDataCues.filter((c) => c.directorId === update!.id);
  const offUpdate = updateDataCues.filter((c) => c.directorId !== update!.id);

  // Drop illegal Update data tags outside Update director.
  if (offUpdate.length > 0) {
    const drop = new Set(offUpdate.map((c) => c.id));
    timeline.actions = timeline.actions.filter((c) => !drop.has(c.id));
  }

  if (onUpdate.length === 0) {
    timeline.actions.push(createUpdateDataCue(update.id, update.durationFrames));
  } else if (onUpdate.length > 1) {
    // Keep first; strip updateData from the rest (or remove empty cues).
    for (let i = 1; i < onUpdate.length; i++) {
      const cue = onUpdate[i]!;
      cue.items = cue.items.filter((it) => !(it.command === 'tag' && it.parameterTag === 'updateData'));
      if (cue.items.length === 0) {
        timeline.actions = timeline.actions.filter((c) => c.id !== cue.id);
      }
    }
  }
}

/** Armed Update = ≥1 track assigned to Update AND ≥2 keyframes on those tracks. */
export function isUpdateDirectorArmed(timeline: Timeline): boolean {
  const update = timeline.directors.find((d) => isUpdateDirectorName(d.name));
  if (!update) return false;
  const tracks = Object.entries(timeline.trackDirectors).filter(([, did]) => did === update.id);
  if (tracks.length === 0) return false;

  let kfCount = 0;
  for (const [key] of tracks) {
    const parts = key.split(':');
    if (parts.length >= 3 && (parts[0] === 'layer' || parts[0] === 'group')) {
      const kind = parts[0];
      const id = parts[1]!;
      const prop = parts.slice(2).join(':');
      for (const kf of timeline.keyframes) {
        const bag = (kind === 'layer' ? kf.layers : kf.groups)[id] as Record<string, unknown> | undefined;
        if (bag && bag[prop] !== undefined) kfCount += 1;
      }
    } else {
      // Legacy target-id key: count any animated props on that target.
      for (const kf of timeline.keyframes) {
        const layerBag = kf.layers[key];
        if (layerBag) kfCount += Object.keys(layerBag).length;
        const groupBag = kf.groups[key];
        if (groupBag) kfCount += Object.keys(groupBag).length;
      }
    }
  }
  return kfCount >= 2;
}

/**
 * Whether air/editor must run the per-director Action state machine from TAKE.
 *
 * Tags do not alter director state: classic playback can dispatch endScene,
 * while Update promotes to director runtime only when UPDATE arrives. Keeping
 * both off this gate avoids charging every TAKE for dormant action machinery.
 */
export function timelineNeedsDirectorRuntime(timeline: Timeline): boolean {
  for (const cue of timeline.actions) {
    for (const item of cue.items) {
      if (!item.command) continue;
      if (
        item.command === 'startDirector'
        || item.command === 'stopDirector'
        || item.command === 'stopDirectorAndWaitContinue'
        || item.command === 'pauseDirector'
      ) {
        return true;
      }
    }
  }
  return false;
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
  const update = createUpdateDirector();
  const timeline: Timeline = {
    fps: 50,
    durationFrames: 500,
    playbackMode: 'bounded',
    directors: [defaultDirector, update],
    trackDirectors: {},
    keyframes: [],
    actions: [createUpdateDataCue(update.id, update.durationFrames)],
  };
  return timeline;
}

export function createDefaultTemplate(): Template {
  return {
    id: randomUUID(),
    name: 'Untitled',
    layerId: DEFAULT_TEMPLATE_LAYER_ID,
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

/** Apply a TextStyle textTransform to already-resolved string content. */
export function applyTextTransform(
  text: string,
  mode: TextTransformMode | undefined,
): string {
  switch (mode ?? 'none') {
    case 'uppercase':
      return text.toLocaleUpperCase();
    case 'lowercase':
      return text.toLocaleLowerCase();
    case 'titlecase':
      return text.replace(/\S+/g, (word) =>
        word.charAt(0).toLocaleUpperCase() + word.slice(1).toLocaleLowerCase(),
      );
    case 'none':
    default:
      return text;
  }
}

/**
 * Soft-migrate / fill defaults for TextStyle so older templates (distance-only
 * shadow, missing textTransform) render and validate cleanly.
 */
export function normalizeTextStyle(style: TextStyle): TextStyle {
  const legacy = typeof style.dropShadowDistance === 'number' ? style.dropShadowDistance : undefined;
  const hasX = typeof style.dropShadowOffsetX === 'number';
  const hasY = typeof style.dropShadowOffsetY === 'number';

  let offsetX: number;
  let offsetY: number;
  if (hasX || hasY) {
    offsetX = hasX ? style.dropShadowOffsetX! : 0;
    offsetY = hasY ? style.dropShadowOffsetY! : 1;
  } else if (legacy !== undefined) {
    // Old templates: renderer used X=0 and distance as Y.
    offsetX = 0;
    offsetY = legacy;
  } else {
    offsetX = 1;
    offsetY = 1;
  }

  const next: TextStyle = {
    ...style,
    textTransform: style.textTransform ?? 'none',
    dropShadowOffsetX: offsetX,
    dropShadowOffsetY: offsetY,
    dropShadowBlur: typeof style.dropShadowBlur === 'number' ? style.dropShadowBlur : 0,
    dropShadowColor: style.dropShadowColor || '#000000',
  };
  delete next.dropShadowDistance;
  return next;
}

/** Soft-migrate Transform: fill missing `z` (pre-translateZ templates). */
export function normalizeTransform(t: Transform): Transform {
  if (typeof t.z === 'number' && Number.isFinite(t.z)) return t;
  return { ...t, z: 0 };
}

/** Normalize transforms on a loaded template (in-place). */
export function normalizeTemplateTransforms(template: Template): void {
  for (const layer of template.layers) {
    layer.transform = normalizeTransform(layer.transform);
  }
  for (const g of template.groups) {
    g.transform = normalizeTransform(g.transform);
  }
}

/** Normalize text/clock/crawl layer styles on a loaded template (in-place). */
export function normalizeTemplateTextStyles(template: Template): void {
  normalizeTemplateTransforms(template);
  for (const layer of template.layers) {
    if (layer.type === 'text' || layer.type === 'clock' || layer.type === 'crawl') {
      layer.style = normalizeTextStyle(layer.style);
    }
    if (layer.type === 'crawl') {
      layer.crawl = normalizeCrawlProps(layer.crawl);
    }
    if (layer.type === 'video') {
      if (layer.endBehavior !== 'lastFrame' && layer.endBehavior !== 'empty') {
        layer.endBehavior = 'lastFrame';
      }
    }
  }
}

export function defaultCrawlProps(): CrawlProps {
  return {
    type: 'ticker',
    directionIn: 'right',
    directionOut: 'left',
    speed: 5,
    pause: 0,
    separatorMode: 'none',
    separatorText: '',
    separatorImage: '',
    animationType: 'batch',
    useFile: false,
    filePath: '',
    maxTextLengthEnabled: false,
    maxTextLength: 80,
  };
}

export function normalizeCrawlProps(crawl: Partial<CrawlProps> | undefined): CrawlProps {
  const base = defaultCrawlProps();
  if (!crawl) return base;
  const type = crawl.type === 'ticker' || crawl.type === 'carousel' ? crawl.type : base.type;
  const dirs = type === 'ticker'
    ? { in: 'right' as const, out: 'left' as const }
    : { in: 'up' as const, out: 'down' as const };
  return {
    type,
    directionIn: crawl.directionIn ?? dirs.in,
    directionOut: crawl.directionOut ?? dirs.out,
    speed: typeof crawl.speed === 'number' && crawl.speed > 0 ? crawl.speed : base.speed,
    pause: typeof crawl.pause === 'number' && crawl.pause >= 0 ? Math.round(crawl.pause) : base.pause,
    separatorMode: crawl.separatorMode === 'text' || crawl.separatorMode === 'image' || crawl.separatorMode === 'none'
      ? crawl.separatorMode
      : base.separatorMode,
    separatorText: crawl.separatorText ?? '',
    separatorImage: crawl.separatorImage ?? '',
    animationType: crawl.animationType === 'continuous' ? 'continuous' : 'batch',
    useFile: Boolean(crawl.useFile),
    filePath: crawl.filePath ?? '',
    maxTextLengthEnabled: Boolean(crawl.maxTextLengthEnabled),
    maxTextLength: typeof crawl.maxTextLength === 'number' && crawl.maxTextLength > 0
      ? Math.floor(crawl.maxTextLength)
      : base.maxTextLength,
  };
}

/** Split crawl content into data lines (hard newlines only; spaces preserved). */
export function splitCrawlLines(raw: string, maxLenEnabled: boolean, maxLen: number): string[] {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  return lines.map((line) => {
    if (!maxLenEnabled || maxLen <= 0) return line;
    return line.length > maxLen ? line.slice(0, maxLen) : line;
  });
}
