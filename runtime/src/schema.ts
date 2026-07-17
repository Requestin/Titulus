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

export type VariableType = 'text' | 'image' | 'number' | 'color' | 'video' | 'multitext' | 'textfile';

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
  cornerRadius: number;
  borderColor: string;
  borderWidth: number;
}

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
  'x', 'y', 'width', 'height',
  'rotation', 'rotationX', 'rotationY', 'perspective',
  'scaleX', 'scaleY',
  'opacity',
  /** Crawl scroll progress 0..1 (dedicated Crawl director track). */
  'crawlProgress',
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
 */
export interface TimelineActionCue {
  id: string;
  directorId: string;
  frame: number;
  name: string;
  items: TimelineActionItem[];
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

export interface Template {
  schemaVersion?: string;
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  metadata?: TemplateMetadata;
  canvas: Canvas;
  variables: Variable[];
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
 * Whether air/editor must run the per-director Action state machine.
 *
 * Dormant Update (autostart=false, unarmed, only seed updateData cue) must NOT
 * force this — otherwise every take pays Action-runtime cost and looks jerky
 * on SDI even when the operator never used Actions.
 */
export function timelineNeedsDirectorRuntime(timeline: Timeline): boolean {
  const updateArmed = isUpdateDirectorArmed(timeline);
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
      if (item.command === 'tag') {
        if (item.parameterTag === 'endScene') return true;
        if (item.parameterTag === 'updateData' && updateArmed) return true;
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

/** Normalize text/clock/crawl layer styles on a loaded template (in-place). */
export function normalizeTemplateTextStyles(template: Template): void {
  for (const layer of template.layers) {
    if (layer.type === 'text' || layer.type === 'clock' || layer.type === 'crawl') {
      layer.style = normalizeTextStyle(layer.style);
    }
    if (layer.type === 'crawl') {
      layer.crawl = normalizeCrawlProps(layer.crawl);
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
