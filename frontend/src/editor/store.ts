// frontend/src/editor/store.ts
//
// Editor state: the editable Template, selection, zoom/grid, and undoable
// mutations (Zustand + zundo). Only `template` is tracked for undo/redo
// (selection/zoom are transient). Every mutation replaces `template` with a new
// object (structuredClone) so zundo records discrete history steps.

import { create, useStore } from 'zustand';
import { temporal } from 'zundo';
import type {
  Template, Layer, LayerType, Variable, Transform, RootStackEntry,
  TimelineDirector, TimelineKeyframe, AnimatableProp, EasingType,
  TimelineActionCue, TimelineActionItem,
} from '@runtime';
import {
  ANIMATABLE_PROPS,
  createDefaultTransform,
  createDefaultActionItem,
  ensureUpdateDirector,
  estimateCrawlDurationFrames,
  isUpdateDirectorName,
  normalizeTemplateTextStyles,
  resolveTrackDirector,
  splitCrawlLines,
  effectiveActionFrame,
  actionFrameFromEffective,
  defaultRectGradient,
  type RectGradientProp,
} from '@runtime';
import { createId } from '@/core/id';
import { createLayer, createVariable, LAYER_LABEL } from './factories';
import { reparentEntriesIntoGroup } from './groupBounds';
import {
  recomputeCrawlDirectorDuration,
  recomputeCrawlDirectorsForVariable,
  removeCrawlDirector,
  ensureCrawlProgressTrack,
} from './crawlTimeline';
import { removeRectGradientTracks } from './rectGradientTimeline';
import { trackKey, type TimelineTrack } from './timelineTracks';

const GRADIENT_CORNER_PROP: Record<
  'upperLeft' | 'lowerLeft' | 'upperRight' | 'lowerRight',
  RectGradientProp
> = {
  upperLeft: 'UpperLeft',
  lowerLeft: 'LowerLeft',
  upperRight: 'UpperRight',
  lowerRight: 'LowerRight',
};

export type Selection = { kind: 'layer' | 'group'; id: string } | null;
export type Target = { kind: 'layer' | 'group'; id: string };

function migrateLoadedTemplate(t: Template): Template {
  const next = structuredClone(t);
  // Drop legacy flat actions (pre-cue schema).
  next.timeline.actions = (next.timeline.actions as unknown[]).filter(
    (a): a is TimelineActionCue =>
      !!a && typeof a === 'object' && Array.isArray((a as TimelineActionCue).items) && (a as TimelineActionCue).items.length > 0,
  );
  ensureUpdateDirector(next.timeline);
  return next;
}

function baseValue(t: Template, target: Target, prop: AnimatableProp): number {
  if (prop === 'crawlProgress' || prop === 'videoProgress') return 0;
  if (target.kind === 'layer') {
    const l = t.layers.find((x) => x.id === target.id);
    if (!l) return 0;
    if (prop === 'opacity') return l.opacity;
    if (l.type === 'rect' && l.gradient) {
      if (prop === 'UpperLeft') return l.gradient.upperLeft.value;
      if (prop === 'LowerLeft') return l.gradient.lowerLeft.value;
      if (prop === 'UpperRight') return l.gradient.upperRight.value;
      if (prop === 'LowerRight') return l.gradient.lowerRight.value;
    }
    if (prop === 'UpperLeft' || prop === 'LowerLeft' || prop === 'UpperRight' || prop === 'LowerRight') {
      return 100;
    }
    return (l.transform as unknown as Record<string, number>)[prop] ?? 0;
  }
  const g = t.groups.find((x) => x.id === target.id);
  if (!g) return prop === 'opacity' ? 1 : 0;
  if (prop === 'opacity') return 1;
  return (g.transform as unknown as Record<string, number>)[prop] ?? 0;
}

function kfAt(t: Template, frame: number): TimelineKeyframe {
  let kf = t.timeline.keyframes.find((k) => k.frame === frame);
  if (!kf) {
    kf = { id: createId(), frame, layers: {}, groups: {}, easing: 'power2.out' };
    t.timeline.keyframes.push(kf);
    t.timeline.keyframes.sort((a, b) => a.frame - b.frame);
  }
  return kf;
}

function pruneKf(t: Template, kf: TimelineKeyframe): void {
  if (Object.keys(kf.layers).length === 0 && Object.keys(kf.groups).length === 0) {
    t.timeline.keyframes = t.timeline.keyframes.filter((k) => k !== kf);
  }
}

const ANIMATABLE_SET = new Set<string>(ANIMATABLE_PROPS);

function hasAnimatedProp(t: Template, target: Target, prop: AnimatableProp): boolean {
  return t.timeline.keyframes.some((k) => {
    const bag = (target.kind === 'layer' ? k.layers : k.groups)[target.id];
    return bag?.[prop] !== undefined;
  });
}

function syncAnimatedPropsAtPlayhead(
  t: Template,
  target: Target,
  values: Partial<Record<AnimatableProp, number>>,
  playheads: Record<string, number>,
): void {
  for (const [prop, value] of Object.entries(values) as [AnimatableProp, number][]) {
    if (value === undefined || !hasAnimatedProp(t, target, prop)) continue;
    const did = resolveTrackDirector(t.timeline, target, prop);
    if (!did) continue;
    const frame = Math.round(playheads[did] ?? 0);
    const kf = kfAt(t, frame);
    const sec = target.kind === 'layer' ? kf.layers : kf.groups;
    (sec[target.id] ??= {})[prop] = value;
  }
}

function ensureDefaultDirector(t: Template): string {
  if (t.timeline.directors.length === 0) {
    t.timeline.directors.push({
      id: 'default',
      name: 'default',
      durationFrames: t.timeline.durationFrames,
      offsetFrames: 0,
      autostart: true,
      loop: false,
      swing: false,
    });
  }
  return t.timeline.directors[0]!.id;
}

function initPlayheads(directors: TimelineDirector[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of directors) out[d.id] = 0;
  return out;
}

function assignTrackDirector(t: Template, track: TimelineTrack, directorId: string): void {
  const key = trackKey(track.target, track.prop);
  t.timeline.trackDirectors[key] = directorId;
  // Drop legacy bare target mapping when reassigning a single prop track.
  if (t.timeline.trackDirectors[track.target.id] === directorId) {
    delete t.timeline.trackDirectors[track.target.id];
  }
}

function appendTrackOrder(t: Template, directorId: string, key: string): void {
  t.timeline.trackOrder ??= {};
  const list = t.timeline.trackOrder[directorId] ??= [];
  if (!list.includes(key)) list.push(key);
}

function removeFromTrackOrder(t: Template, key: string): void {
  if (!t.timeline.trackOrder) return;
  for (const did of Object.keys(t.timeline.trackOrder)) {
    t.timeline.trackOrder[did] = t.timeline.trackOrder[did]!.filter((k) => k !== key);
  }
}

function sortActionsByEffective(t: Template): void {
  const durByDir = new Map(t.timeline.directors.map((d) => [d.id, d.durationFrames]));
  t.timeline.actions.sort((a, b) => {
    const da = durByDir.get(a.directorId) ?? t.timeline.durationFrames;
    const db = durByDir.get(b.directorId) ?? t.timeline.durationFrames;
    const fa = effectiveActionFrame(a, da);
    const fb = effectiveActionFrame(b, db);
    return fa - fb || a.id.localeCompare(b.id);
  });
}

export type KeyframeMove = {
  target: Target;
  prop: AnimatableProp;
  from: number;
  to: number;
};

export type SelectedKeyframeRef = {
  target: Target;
  prop: AnimatableProp;
  frame: number;
};

function readPropValue(
  t: Template,
  target: Target,
  prop: AnimatableProp,
  frame: number,
): number | undefined {
  const kf = t.timeline.keyframes.find((k) => k.frame === frame);
  if (!kf) return undefined;
  const bag = (target.kind === 'layer' ? kf.layers : kf.groups)[target.id];
  const v = bag?.[prop];
  return typeof v === 'number' ? v : undefined;
}

function removePropAtFrame(t: Template, target: Target, prop: AnimatableProp, frame: number): void {
  const kf = t.timeline.keyframes.find((k) => k.frame === frame);
  if (!kf) return;
  const sec = target.kind === 'layer' ? kf.layers : kf.groups;
  const bag = sec[target.id];
  if (!bag || bag[prop] === undefined) return;
  delete bag[prop];
  if (Object.keys(bag).length === 0) delete sec[target.id];
  pruneKf(t, kf);
}

function writePropAtFrame(
  t: Template,
  target: Target,
  prop: AnimatableProp,
  frame: number,
  value: number,
): void {
  const kf = kfAt(t, Math.round(frame));
  const sec = target.kind === 'layer' ? kf.layers : kf.groups;
  (sec[target.id] ??= {})[prop] = value;
}

/** Two-phase apply: strip all sources first, then write destinations (avoids A→B / B→C clobber). */
function applyKeyframeMoves(t: Template, moves: KeyframeMove[]): void {
  const effective = moves.filter((m) => m.from !== m.to);
  if (effective.length === 0) return;

  const payloads = effective.map((m) => {
    const value = readPropValue(t, m.target, m.prop, m.from);
    return value === undefined ? null : { ...m, value };
  }).filter((x): x is KeyframeMove & { value: number } => x !== null);

  for (const m of payloads) {
    removePropAtFrame(t, m.target, m.prop, m.from);
  }
  for (const m of payloads) {
    writePropAtFrame(t, m.target, m.prop, m.to, m.value);
  }
}

function collectTargetPropFrames(
  t: Template,
  target: Target,
  prop?: AnimatableProp,
): Array<{ prop: AnimatableProp; frame: number; value: number }> {
  const out: Array<{ prop: AnimatableProp; frame: number; value: number }> = [];
  for (const k of t.timeline.keyframes) {
    const bag = (target.kind === 'layer' ? k.layers : k.groups)[target.id];
    if (!bag) continue;
    for (const [p, v] of Object.entries(bag) as [AnimatableProp, number][]) {
      if (prop && p !== prop) continue;
      if (typeof v !== 'number') continue;
      out.push({ prop: p, frame: k.frame, value: v });
    }
  }
  return out;
}

function targetKeyframeSpan(t: Template, target: Target): { min: number; max: number } | null {
  const pts = collectTargetPropFrames(t, target);
  if (pts.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const p of pts) {
    if (p.frame < min) min = p.frame;
    if (p.frame > max) max = p.frame;
  }
  return { min, max };
}

function animatableFromTransformPartial(partial: Partial<Transform>): Partial<Record<AnimatableProp, number>> {
  const out: Partial<Record<AnimatableProp, number>> = {};
  for (const key of Object.keys(partial)) {
    if (!ANIMATABLE_SET.has(key) || key === 'opacity') continue;
    out[key as AnimatableProp] = (partial as Record<string, number>)[key];
  }
  return out;
}

interface EditorState {
  template: Template | null;
  selection: Selection;
  dirty: boolean;
  zoom: number;
  gridSnap: boolean;
  gridSize: number;

  load: (t: Template) => void;
  markSaved: () => void;
  select: (sel: Selection) => void;
  setZoom: (z: number) => void;
  toggleGridSnap: () => void;

  patch: (mutator: (t: Template) => void) => void;
  updateLayer: (id: string, mutator: (l: Layer) => void) => void;
  setLayerOpacity: (id: string, opacity: number) => void;
  setRectFillMode: (id: string, mode: 'solid' | 'gradient') => void;
  setRectGradientCorner: (
    id: string,
    corner: 'upperLeft' | 'lowerLeft' | 'upperRight' | 'lowerRight',
    partial: { color?: string; value?: number },
  ) => void;
  updateTransform: (id: string, partial: Partial<Transform>, kind?: 'layer' | 'group') => void;
  setName: (name: string) => void;
  setCanvas: (partial: Partial<Template['canvas']>) => void;
  addLayer: (type: LayerType) => void;
  duplicateSelected: () => void;
  deleteSelected: () => void;
  deleteEntry: (kind: 'layer' | 'group', id: string) => void;
  toggleVisible: (kind: 'layer' | 'group', id: string) => void;
  toggleLock: (kind: 'layer' | 'group', id: string) => void;
  setLayerGroup: (layerId: string, groupId: string | null) => void;
  addGroup: () => void;
  reorderContainer: (containerId: string | null, ids: string[]) => void;

  addVariable: () => void;
  updateVariable: (id: string, partial: Partial<Variable>) => void;
  removeVariable: (id: string) => void;
  ensureTemplateData: () => void;
  setTemplateData: (data: Template['data']) => void;
  patchTemplateData: (mutator: (data: NonNullable<Template['data']>) => void) => void;

  // timeline + playback (playheads/playing/activeDirectorId are transient)
  playheads: Record<string, number>;
  /** Per-director elapsed rel time for loop/swing playback (transient). */
  directorRel: Record<string, number>;
  playing: boolean;
  waitingContinue: boolean;
  /** Bumped by requestContinue so CanvasArea can resume stopAndWaitContinue. */
  continueRequestId: number;
  activeDirectorId: string;
  setPlayhead: (directorId: string, frame: number) => void;
  setPlayheads: (playheads: Record<string, number>) => void;
  /** Set the same local frame on every director (global scrub). */
  setGlobalPlayhead: (frame: number) => void;
  setDirectorRel: (directorId: string, rel: number) => void;
  setPlaying: (playing: boolean) => void;
  setWaitingContinue: (waiting: boolean) => void;
  requestContinue: () => void;
  setActiveDirector: (id: string) => void;
  setTimelineMeta: (partial: { fps?: number; durationFrames?: number; playbackMode?: 'bounded' | 'infinite' }) => void;
  addDirector: () => void;
  updateDirector: (id: string, partial: Partial<TimelineDirector>) => void;
  removeDirector: (id: string) => void;
  assignTrack: (track: TimelineTrack, directorId: string) => void;
  reorderTracks: (directorId: string, trackKeys: string[]) => void;
  moveTrackToDirector: (track: TimelineTrack, toDirectorId: string, toIndex?: number) => void;
  moveObjectToDirector: (target: Target, toDirectorId: string, beforeTrackKey?: string | null) => void;
  setKeyframeValue: (target: Target, frame: number, prop: AnimatableProp, value: number, directorId?: string) => void;
  movePoint: (target: Target, prop: AnimatableProp, fromFrame: number, toFrame: number) => void;
  moveKeyframeSegment: (target: Target, prop: AnimatableProp, edgeIndex: number, deltaFrames: number) => void;
  shiftKeyframes: (moves: KeyframeMove[]) => void;
  shiftTargetKeyframes: (target: Target, deltaFrames: number) => void;
  scaleTargetKeyframes: (target: Target, newMin: number, newMax: number) => void;
  shiftSelectedKeyframes: (selected: SelectedKeyframeRef[], deltaFrames: number) => SelectedKeyframeRef[] | null;
  deletePoint: (target: Target, prop: AnimatableProp, frame: number) => void;
  removeTrack: (target: Target, prop: AnimatableProp) => void;
  setKeyframeEasing: (frame: number, easing: EasingType) => void;
  addTrackAtPlayhead: (target: Target, prop: AnimatableProp) => void;

  selectedActionCueId: string | null;
  selectActionCue: (id: string | null) => void;
  addActionCueAtPlayhead: () => void;
  removeSelectedActionCue: () => void;
  moveActionCue: (id: string, frame: number) => void;
  updateActionCue: (id: string, partial: Partial<Pick<TimelineActionCue, 'name' | 'frame' | 'fromEnd'>>) => void;
  addActionItem: (cueId: string) => void;
  removeActionItem: (cueId: string, itemId: string) => void;
  updateActionItem: (cueId: string, itemId: string, partial: Partial<TimelineActionItem>) => void;
}

function purgeTimelineTargets(t: Template, ids: string[]): void {
  for (const id of ids) {
    delete t.timeline.trackDirectors[id];
    for (const key of Object.keys(t.timeline.trackDirectors)) {
      if (key.includes(`:${id}:`)) delete t.timeline.trackDirectors[key];
    }
    if (t.timeline.trackOrder) {
      for (const did of Object.keys(t.timeline.trackOrder)) {
        t.timeline.trackOrder[did] = t.timeline.trackOrder[did]!.filter((k) => !k.includes(`:${id}:`));
      }
    }
    for (const kf of t.timeline.keyframes) {
      delete kf.layers[id];
      delete kf.groups[id];
    }
  }
}

function collectGroupSubtree(t: Template, groupId: string): { layerIds: string[]; groupIds: string[] } {
  const layerIds: string[] = [];
  const groupIds: string[] = [groupId];
  for (const entry of t.groupStacks[groupId] ?? []) {
    if (entry.kind === 'layer') {
      layerIds.push(entry.id);
    } else {
      const sub = collectGroupSubtree(t, entry.id);
      layerIds.push(...sub.layerIds);
      groupIds.push(...sub.groupIds);
    }
  }
  return { layerIds, groupIds };
}

function clone(t: Template): Template {
  return structuredClone(t);
}

function removeEntryEverywhere(t: Template, id: string): void {
  t.rootStack = t.rootStack.filter((e) => e.id !== id);
  for (const k of Object.keys(t.groupStacks)) {
    t.groupStacks[k] = t.groupStacks[k].filter((e) => e.id !== id);
  }
}

function addEntry(t: Template, entry: RootStackEntry, containerId: string | null): void {
  if (containerId === null) {
    t.rootStack.push(entry);
  } else {
    (t.groupStacks[containerId] ??= []).push(entry);
  }
}

export const useEditor = create<EditorState>()(
  temporal(
    (set, get) => ({
      template: null,
      selection: null,
      dirty: false,
      zoom: 0.45,
      gridSnap: false,
      gridSize: 8,
      playheads: {},
      directorRel: {},
      playing: false,
      waitingContinue: false,
      continueRequestId: 0,
      activeDirectorId: 'default',
      selectedActionCueId: null,

      load: (t) => {
        const normalized = migrateLoadedTemplate(t);
        normalizeTemplateTextStyles(normalized);
        for (const g of normalized.groups) {
          g.transform.width = 0;
          g.transform.height = 0;
        }
        for (const l of normalized.layers) {
          if (l.type === 'rect' && (l.fillMode ?? 'solid') === 'gradient') {
            l.gradient ??= defaultRectGradient();
          }
        }
        set({
          template: normalized,
          selection: null,
          dirty: false,
          playheads: initPlayheads(normalized.timeline.directors),
          directorRel: initPlayheads(normalized.timeline.directors),
          playing: false,
          waitingContinue: false,
          activeDirectorId: normalized.timeline.directors[0]?.id ?? 'default',
          selectedActionCueId: null,
        });
        useEditor.temporal.getState().clear();
      },
      markSaved: () => set({ dirty: false }),
      select: (sel) => set({ selection: sel, selectedActionCueId: null }),
      setZoom: (z) => set({ zoom: Math.min(2, Math.max(0.1, z)) }),
      toggleGridSnap: () => set((s) => ({ gridSnap: !s.gridSnap })),

      patch: (mutator) => {
        const cur = get().template;
        if (!cur) return;
        const next = clone(cur);
        mutator(next);
        set({ template: next, dirty: true });
      },

      updateLayer: (id, mutator) =>
        get().patch((t) => {
          const l = t.layers.find((x) => x.id === id);
          if (!l) return;
          mutator(l);
          if (l.type === 'crawl') recomputeCrawlDirectorDuration(t, l);
        }),

      setLayerOpacity: (id, opacity) =>
        get().patch((t) => {
          const l = t.layers.find((x) => x.id === id);
          if (!l) return;
          l.opacity = Math.min(1, Math.max(0, opacity));
          syncAnimatedPropsAtPlayhead(
            t,
            { kind: 'layer', id },
            { opacity: l.opacity },
            get().playheads,
          );
        }),

      setRectFillMode: (id, mode) =>
        get().patch((t) => {
          const l = t.layers.find((x) => x.id === id);
          if (!l || l.type !== 'rect') return;
          l.fillMode = mode;
          if (mode === 'gradient') {
            l.gradient ??= defaultRectGradient();
          } else {
            removeRectGradientTracks(t, l.id);
          }
        }),

      setRectGradientCorner: (id, corner, partial) =>
        get().patch((t) => {
          const l = t.layers.find((x) => x.id === id);
          if (!l || l.type !== 'rect') return;
          l.gradient ??= defaultRectGradient();
          Object.assign(l.gradient[corner], partial);
          if (partial.value !== undefined) {
            const value = Math.min(100, Math.max(0, partial.value));
            l.gradient[corner].value = value;
            syncAnimatedPropsAtPlayhead(
              t,
              { kind: 'layer', id },
              { [GRADIENT_CORNER_PROP[corner]]: value },
              get().playheads,
            );
          }
        }),

      updateTransform: (id, partial, kind = 'layer') =>
        get().patch((t) => {
          const target =
            kind === 'layer' ? t.layers.find((x) => x.id === id) : t.groups.find((x) => x.id === id);
          if (!target) return;
          Object.assign(target.transform, partial);
          if (kind === 'group') {
            target.transform.width = 0;
            target.transform.height = 0;
          }
          if (kind === 'layer' && 'type' in target && target.type === 'crawl') {
            recomputeCrawlDirectorDuration(t, target);
          }
          syncAnimatedPropsAtPlayhead(
            t,
            { kind, id },
            animatableFromTransformPartial(partial),
            get().playheads,
          );
        }),

      setName: (name) => get().patch((t) => { t.name = name; }),
      setCanvas: (partial) => get().patch((t) => { Object.assign(t.canvas, partial); }),

      addLayer: (type) => {
        const t0 = get().template;
        if (!t0) return;
        const n = t0.layers.filter((l) => l.type === type).length + 1;
        if (type === 'crawl') {
          const directorId = createId();
          const layer = createLayer('crawl', `${LAYER_LABEL.crawl} ${n}`, directorId);
          if (layer.type !== 'crawl') return;
          const raw = typeof layer.content === 'string' ? layer.content : 'New text1\nNew text2';
          const lines = splitCrawlLines(raw, false, 80);
          const fps = t0.timeline.fps || 50;
          const durationFrames = estimateCrawlDurationFrames({
            lines,
            crawl: layer.crawl,
            boxWidth: layer.transform.width,
            boxHeight: layer.transform.height,
            fontSize: layer.style.fontSize,
            fps,
            align: layer.style.align,
          });
          get().patch((t) => {
            t.timeline.directors.push({
              id: directorId,
              name: 'Crawl',
              durationFrames,
              offsetFrames: 0,
              autostart: true,
              loop: layer.crawl.animationType === 'continuous',
              swing: false,
            });
            const end = durationFrames;
            if (end > t.timeline.durationFrames) t.timeline.durationFrames = end;
            t.layers.push(layer);
            t.rootStack.push({ kind: 'layer', id: layer.id });
            ensureCrawlProgressTrack(t, layer);
          });
          set({
            selection: { kind: 'layer', id: layer.id },
            playheads: { ...get().playheads, [directorId]: 0 },
            directorRel: { ...get().directorRel, [directorId]: 0 },
          });
          return;
        }
        const layer = createLayer(type, `${LAYER_LABEL[type]} ${n}`);
        get().patch((t) => {
          t.layers.push(layer);
          t.rootStack.push({ kind: 'layer', id: layer.id });
        });
        set({ selection: { kind: 'layer', id: layer.id } });
      },

      duplicateSelected: () => {
        const { selection, template } = get();
        if (!selection || selection.kind !== 'layer' || !template) return;
        const src = template.layers.find((l) => l.id === selection.id);
        if (!src) return;
        const copy = structuredClone(src);
        copy.id = createId();
        copy.name = `${src.name} copy`;
        copy.transform.x += 24;
        copy.transform.y += 24;
        copy.groupId = null;
        if (copy.type === 'crawl') {
          const directorId = createId();
          copy.crawlDirectorId = directorId;
          const srcDirectorId = src.type === 'crawl' ? src.crawlDirectorId : '';
          get().patch((t) => {
            const srcDir = t.timeline.directors.find((d) => d.id === srcDirectorId);
            t.timeline.directors.push({
              id: directorId,
              name: 'Crawl',
              durationFrames: srcDir?.durationFrames ?? 100,
              offsetFrames: 0,
              autostart: true,
              loop: copy.crawl.animationType === 'continuous',
              swing: false,
            });
            t.layers.push(copy);
            t.rootStack.push({ kind: 'layer', id: copy.id });
            recomputeCrawlDirectorDuration(t, copy);
            ensureCrawlProgressTrack(t, copy);
          });
        } else {
          get().patch((t) => {
            t.layers.push(copy);
            t.rootStack.push({ kind: 'layer', id: copy.id });
          });
        }
        set({ selection: { kind: 'layer', id: copy.id } });
      },

      deleteEntry: (kind, id) => {
        get().patch((t) => {
          if (kind === 'layer') {
            const layer = t.layers.find((l) => l.id === id);
            if (layer?.type === 'crawl') removeCrawlDirector(t, layer.crawlDirectorId);
            t.layers = t.layers.filter((l) => l.id !== id);
            removeEntryEverywhere(t, id);
            purgeTimelineTargets(t, [id]);
            return;
          }
          const { layerIds, groupIds } = collectGroupSubtree(t, id);
          for (const lid of layerIds) {
            const layer = t.layers.find((l) => l.id === lid);
            if (layer?.type === 'crawl') removeCrawlDirector(t, layer.crawlDirectorId);
          }
          t.layers = t.layers.filter((l) => !layerIds.includes(l.id));
          t.groups = t.groups.filter((g) => !groupIds.includes(g.id));
          for (const gid of groupIds) {
            delete t.groupStacks[gid];
            removeEntryEverywhere(t, gid);
          }
          purgeTimelineTargets(t, [...layerIds, ...groupIds]);
        });
        const sel = get().selection;
        if (sel?.kind === kind && sel.id === id) set({ selection: null });
      },

      deleteSelected: () => {
        const sel = get().selection;
        if (!sel) return;
        get().deleteEntry(sel.kind, sel.id);
      },

      toggleVisible: (kind, id) =>
        get().patch((t) => {
          const target = kind === 'layer' ? t.layers.find((x) => x.id === id) : t.groups.find((x) => x.id === id);
          if (target) target.visible = !target.visible;
        }),

      toggleLock: (kind, id) =>
        get().patch((t) => {
          const target = kind === 'layer' ? t.layers.find((x) => x.id === id) : t.groups.find((x) => x.id === id);
          if (target) target.locked = !target.locked;
        }),

      setLayerGroup: (layerId, groupId) =>
        get().patch((t) => {
          const l = t.layers.find((x) => x.id === layerId);
          if (!l) return;
          const prevGroupId = l.groupId;
          const entry = { kind: 'layer' as const, id: layerId };
          removeEntryEverywhere(t, layerId);
          l.groupId = groupId;
          if (groupId) {
            addEntry(t, entry, groupId);
            reparentEntriesIntoGroup(t, groupId, [entry]);
          } else {
            addEntry(t, entry, null);
          }
          if (prevGroupId) {
            const g = t.groups.find((x) => x.id === prevGroupId);
            if (g) {
              g.transform.width = 0;
              g.transform.height = 0;
            }
          }
        }),

      addGroup: () => {
        const t0 = get().template;
        if (!t0) return;
        const n = t0.groups.length + 1;
        const id = createId();
        get().patch((t) => {
          t.groups.push({
            id, name: `Group ${n}`, parentId: null, visible: true, locked: false,
            transform: { ...createDefaultTransform(0, 0), width: 0, height: 0, anchorX: 0, anchorY: 0 },
          });
          t.groupStacks[id] = [];
          t.rootStack.push({ kind: 'group', id });
        });
        set({ selection: { kind: 'group', id } });
      },

      reorderContainer: (containerId, ids) =>
        get().patch((t) => {
          const arr = containerId === null ? t.rootStack : (t.groupStacks[containerId] ?? []);
          const byId = new Map(arr.map((e) => [e.id, e]));
          const next = ids.map((id) => byId.get(id)).filter((e): e is RootStackEntry => Boolean(e));
          if (containerId === null) t.rootStack = next;
          else t.groupStacks[containerId] = next;
        }),

      addVariable: () => {
        const t0 = get().template;
        if (!t0) return;
        const n = t0.variables.length + 1;
        get().patch((t) => { t.variables.push(createVariable(`var${n}`)); });
      },

      updateVariable: (id, partial) =>
        get().patch((t) => {
          const v = t.variables.find((x) => x.id === id);
          if (v) Object.assign(v, partial);
          // Crawl director length depends on resolved content length.
          if (partial.defaultValue !== undefined) {
            recomputeCrawlDirectorsForVariable(t, id);
          }
        }),

      removeVariable: (id) =>
        get().patch((t) => {
          t.variables = t.variables.filter((v) => v.id !== id);
          recomputeCrawlDirectorsForVariable(t, id);
        }),

      ensureTemplateData: () => {
        get().patch((t) => {
          if (!t.data) {
            t.data = {
              version: 1,
              sources: [],
              pipelines: [],
              runOn: ['take', 'load'],
              onError: 'block',
            };
          }
        });
      },

      setTemplateData: (data) =>
        get().patch((t) => {
          if (data === undefined) delete t.data;
          else t.data = data;
        }),

      patchTemplateData: (mutator) =>
        get().patch((t) => {
          if (!t.data) {
            t.data = {
              version: 1,
              sources: [],
              pipelines: [],
              runOn: ['take', 'load'],
              onError: 'block',
            };
          }
          mutator(t.data);
        }),

      // --- timeline + playback ---
      setPlayhead: (directorId, frame) =>
        set((s) => ({
          playheads: { ...s.playheads, [directorId]: Math.max(0, Math.round(frame)) },
          directorRel: { ...s.directorRel, [directorId]: Math.max(0, Math.round(frame)) },
        })),
      // One atomic write for playheads + directorRel (Play loop must not N× setDirectorRel).
      setPlayheads: (playheads) => set({ playheads, directorRel: { ...playheads } }),
      setGlobalPlayhead: (frame) => {
        const t = get().template;
        if (!t) return;
        const f = Math.max(0, Math.round(frame));
        set((s) => {
          const playheads = { ...s.playheads };
          const directorRel = { ...s.directorRel };
          for (const d of t.timeline.directors) {
            const local = Math.min(f, d.durationFrames);
            playheads[d.id] = local;
            directorRel[d.id] = local;
          }
          return { playheads, directorRel, playing: false };
        });
      },
      setDirectorRel: (directorId, rel) =>
        set((s) => ({ directorRel: { ...s.directorRel, [directorId]: Math.max(0, rel) } })),
      setPlaying: (playing) => set((s) => {
        if (!playing) return { playing: false, waitingContinue: false };
        const t = get().template;
        const directorRel = { ...s.directorRel };
        for (const d of t?.timeline.directors ?? []) {
          directorRel[d.id] = s.playheads[d.id] ?? 0;
        }
        return { playing: true, directorRel, waitingContinue: false };
      }),
      setWaitingContinue: (waiting) => set({ waitingContinue: waiting }),
      requestContinue: () => set((s) => ({ continueRequestId: s.continueRequestId + 1 })),
      setActiveDirector: (id) => set({ activeDirectorId: id, playing: false, waitingContinue: false }),

      setTimelineMeta: (partial) => get().patch((t) => { Object.assign(t.timeline, partial); }),

      addDirector: () => {
        const t0 = get().template;
        if (!t0) return;
        const n = t0.timeline.directors.length + 1;
        const id = createId();
        get().patch((t) => {
          t.timeline.directors.push({
            id, name: `Director ${n}`,
            durationFrames: t.timeline.durationFrames, offsetFrames: 0,
            autostart: true, loop: false, swing: false,
          });
          t.timeline.trackOrder ??= {};
          t.timeline.trackOrder[id] = [];
        });
        set((s) => ({
          activeDirectorId: id,
          playheads: { ...s.playheads, [id]: 0 },
          directorRel: { ...s.directorRel, [id]: 0 },
        }));
      },

      updateDirector: (id, partial) =>
        get().patch((t) => {
          const d = t.timeline.directors.find((x) => x.id === id);
          if (!d) return;
          if (isUpdateDirectorName(d.name) && partial.name !== undefined && !isUpdateDirectorName(partial.name)) {
            return; // Update director cannot be renamed
          }
          Object.assign(d, partial);
          if (isUpdateDirectorName(d.name)) d.name = 'Update';
          if (partial.offsetFrames !== undefined || partial.durationFrames !== undefined) {
            for (const layer of t.layers) {
              if (layer.type === 'crawl' && layer.crawlDirectorId === id) {
                ensureCrawlProgressTrack(t, layer);
              }
            }
          }
        }),

      removeDirector: (id) => {
        const t0 = get().template;
        if (!t0) return;
        const treeDirector = t0.timeline.directors.find((d) => d.id === id);
        if (!treeDirector) return;
        if (isUpdateDirectorName(treeDirector.name)) return;

        get().patch((t) => {
          const tracksToRemove: TimelineTrack[] = [];
          for (const [key, did] of Object.entries(t.timeline.trackDirectors)) {
            if (did !== id) continue;
            const parsed = key.includes(':') ? key.split(':') : null;
            if (parsed && parsed.length >= 3) {
              tracksToRemove.push({
                target: { kind: parsed[0] as 'layer' | 'group', id: parsed[1]! },
                prop: parsed.slice(2).join(':') as AnimatableProp,
              });
            }
          }
          for (const track of tracksToRemove) {
            for (const kf of t.timeline.keyframes) {
              const sec = track.target.kind === 'layer' ? kf.layers : kf.groups;
              const bag = sec[track.target.id];
              if (!bag || bag[track.prop] === undefined) continue;
              delete bag[track.prop];
              if (Object.keys(bag).length === 0) delete sec[track.target.id];
              if (Object.keys(kf.layers).length === 0 && Object.keys(kf.groups).length === 0) {
                t.timeline.keyframes = t.timeline.keyframes.filter((k) => k !== kf);
              }
            }
            delete t.timeline.trackDirectors[trackKey(track.target, track.prop)];
            removeFromTrackOrder(t, trackKey(track.target, track.prop));
          }

          t.timeline.directors = t.timeline.directors.filter((d) => d.id !== id);
          for (const k of Object.keys(t.timeline.trackDirectors)) {
            if (t.timeline.trackDirectors[k] === id) delete t.timeline.trackDirectors[k];
          }
          if (t.timeline.trackOrder) delete t.timeline.trackOrder[id];
          t.timeline.actions = t.timeline.actions.filter((a) => {
            if (a.directorId === id) return false;
            a.items = a.items.filter((it) => it.parameterDirectorId !== id);
            return a.items.length > 0;
          });
        });

        const next = get().template?.timeline.directors[0]?.id;
        set((s) => {
          const playheads = { ...s.playheads };
          const directorRel = { ...s.directorRel };
          delete playheads[id];
          delete directorRel[id];
          const still = get().template?.timeline.actions.some((a) => a.id === s.selectedActionCueId);
          return {
            activeDirectorId: s.activeDirectorId === id ? (next ?? 'default') : s.activeDirectorId,
            playheads,
            directorRel,
            selectedActionCueId: still ? s.selectedActionCueId : null,
          };
        });
      },

      assignTrack: (track, directorId) =>
        get().patch((t) => {
          assignTrackDirector(t, track, directorId);
          appendTrackOrder(t, directorId, trackKey(track.target, track.prop));
        }),

      selectActionCue: (id) => set({ selectedActionCueId: id, selection: id ? null : get().selection }),

      addActionCueAtPlayhead: () => {
        const st = get();
        const t0 = st.template;
        if (!t0) return;
        const directorId = st.activeDirectorId;
        const dir = t0.timeline.directors.find((d) => d.id === directorId);
        if (!dir) return;
        const frame = Math.max(0, Math.min(dir.durationFrames, Math.round(st.playheads[directorId] ?? 0)));
        const existing = t0.timeline.actions.find(
          (a) => a.directorId === directorId && effectiveActionFrame(a, dir.durationFrames) === frame,
        );
        if (existing) {
          get().patch((t) => {
            const cue = t.timeline.actions.find((a) => a.id === existing.id);
            if (!cue) return;
            const firstDir = t.timeline.directors[0]?.id ?? directorId;
            cue.items.push(createDefaultActionItem({
              command: null,
              parameterDirectorId: firstDir,
              parameterTag: isUpdateDirectorName(dir.name) ? 'updateData' : 'endScene',
            }));
          });
          set({ selectedActionCueId: existing.id, selection: null });
          return;
        }
        const cueId = createId();
        const firstDir = t0.timeline.directors[0]?.id ?? directorId;
        get().patch((t) => {
          t.timeline.actions.push({
            id: cueId,
            directorId,
            frame,
            name: '',
            items: [
              createDefaultActionItem({
                command: null,
                parameterDirectorId: firstDir,
                parameterTag: isUpdateDirectorName(dir.name) ? 'updateData' : 'endScene',
              }),
            ],
          });
          sortActionsByEffective(t);
        });
        set({ selectedActionCueId: cueId, selection: null });
      },

      removeSelectedActionCue: () => {
        const id = get().selectedActionCueId;
        if (!id) return;
        get().patch((t) => {
          t.timeline.actions = t.timeline.actions.filter((a) => a.id !== id);
        });
        set({ selectedActionCueId: null });
      },

      moveActionCue: (id, frame) => {
        let selectId: string | null = id;
        get().patch((t) => {
          const cue = t.timeline.actions.find((a) => a.id === id);
          if (!cue) return;
          const dir = t.timeline.directors.find((d) => d.id === cue.directorId);
          const max = dir?.durationFrames ?? t.timeline.durationFrames;
          const nextEffective = Math.max(0, Math.min(max, Math.round(frame)));
          const stored = actionFrameFromEffective(nextEffective, max, cue.fromEnd);
          const other = t.timeline.actions.find(
            (a) => a.id !== id
              && a.directorId === cue.directorId
              && effectiveActionFrame(a, max) === nextEffective,
          );
          if (other) {
            other.items.push(...cue.items);
            t.timeline.actions = t.timeline.actions.filter((a) => a.id !== id);
            selectId = other.id;
          } else {
            cue.frame = stored;
          }
          sortActionsByEffective(t);
        });
        set({ selectedActionCueId: selectId });
      },

      updateActionCue: (id, partial) =>
        get().patch((t) => {
          const cue = t.timeline.actions.find((a) => a.id === id);
          if (!cue) return;
          const dir = t.timeline.directors.find((d) => d.id === cue.directorId);
          const max = dir?.durationFrames ?? t.timeline.durationFrames;
          if (partial.name !== undefined) cue.name = partial.name;

          if (partial.fromEnd !== undefined && partial.fromEnd !== !!cue.fromEnd) {
            // Keep marker position: convert absolute ↔ offset.
            const effective = effectiveActionFrame(cue, max);
            cue.fromEnd = partial.fromEnd || undefined;
            cue.frame = actionFrameFromEffective(effective, max, cue.fromEnd);
          }

          if (partial.frame !== undefined) {
            const next = Math.max(0, Math.round(partial.frame));
            // In fromEnd mode the number is an offset (not clamped to dur as absolute).
            cue.frame = cue.fromEnd ? next : Math.max(0, Math.min(max, next));
          }
          sortActionsByEffective(t);
        }),

      addActionItem: (cueId) =>
        get().patch((t) => {
          const cue = t.timeline.actions.find((a) => a.id === cueId);
          if (!cue) return;
          const dir = t.timeline.directors.find((d) => d.id === cue.directorId);
          const firstDir = t.timeline.directors[0]?.id ?? cue.directorId;
          cue.items.push(createDefaultActionItem({
            command: null,
            parameterDirectorId: firstDir,
            parameterTag: dir && isUpdateDirectorName(dir.name) ? 'updateData' : 'endScene',
          }));
        }),

      removeActionItem: (cueId, itemId) =>
        get().patch((t) => {
          const cue = t.timeline.actions.find((a) => a.id === cueId);
          if (!cue || cue.items.length <= 1) return;
          cue.items = cue.items.filter((it) => it.id !== itemId);
        }),

      updateActionItem: (cueId, itemId, partial) =>
        get().patch((t) => {
          const cue = t.timeline.actions.find((a) => a.id === cueId);
          if (!cue) return;
          const item = cue.items.find((it) => it.id === itemId);
          if (!item) return;
          Object.assign(item, partial);
          // Tag restrictions: Update director only updateData; others only endScene
          const dir = t.timeline.directors.find((d) => d.id === cue.directorId);
          if (item.command === 'tag' && dir) {
            if (isUpdateDirectorName(dir.name)) {
              if (item.parameterTag === 'endScene') item.parameterTag = 'updateData';
            } else if (item.parameterTag === 'updateData') {
              item.parameterTag = 'endScene';
            }
          }
          // Enforce single updateData on template
          if (item.command === 'tag' && item.parameterTag === 'updateData') {
            for (const other of t.timeline.actions) {
              for (const it of other.items) {
                if (it.id === itemId) continue;
                if (it.command === 'tag' && it.parameterTag === 'updateData') {
                  it.parameterTag = null;
                  it.command = null;
                }
              }
            }
          }
        }),

      reorderTracks: (directorId, trackKeys) =>
        get().patch((t) => {
          t.timeline.trackOrder ??= {};
          t.timeline.trackOrder[directorId] = [...trackKeys];
        }),

      moveTrackToDirector: (track, toDirectorId, toIndex) =>
        get().patch((t) => {
          const key = trackKey(track.target, track.prop);
          const fromDirector = resolveTrackDirector(t.timeline, track.target, track.prop)
            ?? t.timeline.directors[0]?.id
            ?? 'default';
          assignTrackDirector(t, track, toDirectorId);
          t.timeline.trackOrder ??= {};
          if (fromDirector !== toDirectorId && t.timeline.trackOrder[fromDirector]) {
            t.timeline.trackOrder[fromDirector] = t.timeline.trackOrder[fromDirector]!.filter((k) => k !== key);
          }
          const dest = t.timeline.trackOrder[toDirectorId] ??= [];
          const without = dest.filter((k) => k !== key);
          const idx = toIndex === undefined ? without.length : Math.max(0, Math.min(toIndex, without.length));
          without.splice(idx, 0, key);
          t.timeline.trackOrder[toDirectorId] = without;
        }),

      moveObjectToDirector: (target, toDirectorId, beforeTrackKey) =>
        get().patch((t) => {
          const keySet = new Set<string>();
          for (const k of Object.keys(t.timeline.trackDirectors)) {
            const parts = k.split(':');
            if (parts[0] === target.kind && parts[1] === target.id) keySet.add(k);
          }
          for (const kf of t.timeline.keyframes) {
            const bag = (target.kind === 'layer' ? kf.layers : kf.groups)[target.id];
            if (!bag) continue;
            for (const prop of Object.keys(bag) as AnimatableProp[]) {
              keySet.add(trackKey(target, prop));
            }
          }
          const keys = [...keySet];
          if (keys.length === 0) return;

          t.timeline.trackOrder ??= {};
          for (const did of Object.keys(t.timeline.trackOrder)) {
            t.timeline.trackOrder[did] = t.timeline.trackOrder[did]!.filter((k) => !keySet.has(k));
          }
          for (const key of keys) {
            const parts = key.split(':');
            const prop = parts.slice(2).join(':') as AnimatableProp;
            assignTrackDirector(t, { target, prop }, toDirectorId);
          }

          const dest = t.timeline.trackOrder[toDirectorId] ??= [];
          const existing = new Set(dest);
          const toInsert = keys.filter((k) => !existing.has(k));
          if (toInsert.length === 0) return;

          let insertAt = dest.length;
          if (beforeTrackKey) {
            const idx = dest.indexOf(beforeTrackKey);
            if (idx >= 0) insertAt = idx;
          }
          dest.splice(insertAt, 0, ...toInsert);
          t.timeline.trackOrder[toDirectorId] = dest;
        }),

      setKeyframeValue: (target, frame, prop, value, directorId) =>
        get().patch((t) => {
          const did = directorId ?? get().activeDirectorId;
          ensureDefaultDirector(t);
          const kf = kfAt(t, Math.round(frame));
          const sec = target.kind === 'layer' ? kf.layers : kf.groups;
          (sec[target.id] ??= {})[prop] = value;
          assignTrackDirector(t, { target, prop }, did);
          appendTrackOrder(t, did, trackKey(target, prop));
        }),

      movePoint: (target, prop, fromFrame, toFrame) => {
        if (fromFrame === toFrame) return;
        get().patch((t) => {
          // Block overwrite of a different keyframe on the same prop.
          const destVal = readPropValue(t, target, prop, Math.round(toFrame));
          if (destVal !== undefined && Math.round(toFrame) !== fromFrame) return;
          applyKeyframeMoves(t, [{ target, prop, from: fromFrame, to: Math.round(toFrame) }]);
        });
      },

      moveKeyframeSegment: (target, prop, edgeIndex, deltaFrames) => {
        if (deltaFrames === 0) return;
        get().patch((t) => {
          const points: { frame: number; value: number }[] = [];
          for (const k of t.timeline.keyframes) {
            const bag = (target.kind === 'layer' ? k.layers : k.groups)[target.id];
            if (bag && bag[prop] !== undefined) points.push({ frame: k.frame, value: bag[prop] as number });
          }
          points.sort((a, b) => a.frame - b.frame);
          if (edgeIndex < 0 || edgeIndex >= points.length - 1) return;

          const component = new Set<number>();
          const stack = [edgeIndex, edgeIndex + 1];
          while (stack.length) {
            const i = stack.pop()!;
            if (component.has(i)) continue;
            component.add(i);
            if (i > 0 && points[i - 1]!.value !== points[i]!.value) stack.push(i - 1);
            if (i < points.length - 1 && points[i]!.value !== points[i + 1]!.value) stack.push(i + 1);
          }

          const moving = [...component].sort((a, b) => a - b).map((i) => points[i]!.frame);
          const fixed = new Set(points.map((p) => p.frame).filter((f) => !moving.includes(f)));

          const targetFrames = moving.map((f) => Math.max(0, f + deltaFrames));
          for (let i = 1; i < targetFrames.length; i++) {
            if (targetFrames[i]! <= targetFrames[i - 1]!) targetFrames[i] = targetFrames[i - 1]! + 1;
          }
          for (const tf of targetFrames) {
            if (fixed.has(tf)) return;
          }

          applyKeyframeMoves(
            t,
            moving.map((from, i) => ({ target, prop, from, to: targetFrames[i]! })),
          );
        });
      },

      shiftKeyframes: (moves) => {
        if (moves.length === 0) return;
        get().patch((t) => { applyKeyframeMoves(t, moves); });
      },

      shiftTargetKeyframes: (target, deltaFrames) => {
        if (deltaFrames === 0) return;
        get().patch((t) => {
          const pts = collectTargetPropFrames(t, target);
          if (pts.length === 0) return;
          const moves: KeyframeMove[] = pts.map((p) => ({
            target,
            prop: p.prop,
            from: p.frame,
            to: Math.max(0, p.frame + deltaFrames),
          }));
          // Preserve relative order per prop if clamping collapses.
          const byProp = new Map<AnimatableProp, KeyframeMove[]>();
          for (const m of moves) {
            const list = byProp.get(m.prop) ?? [];
            list.push(m);
            byProp.set(m.prop, list);
          }
          const fixedMoves: KeyframeMove[] = [];
          for (const [, list] of byProp) {
            list.sort((a, b) => a.from - b.from);
            for (let i = 1; i < list.length; i++) {
              if (list[i]!.to <= list[i - 1]!.to) list[i]!.to = list[i - 1]!.to + 1;
            }
            fixedMoves.push(...list);
          }
          applyKeyframeMoves(t, fixedMoves);
        });
      },

      scaleTargetKeyframes: (target, newMin, newMax) => {
        get().patch((t) => {
          const span = targetKeyframeSpan(t, target);
          if (!span) return;
          const { min: oldMin, max: oldMax } = span;
          const oldRange = oldMax - oldMin;
          let nMin = Math.max(0, Math.round(newMin));
          let nMax = Math.max(0, Math.round(newMax));
          if (nMax < nMin) {
            const tmp = nMin;
            nMin = nMax;
            nMax = tmp;
          }
          if (oldRange === 0) {
            // Single-frame span: move all to nMin (or keep if both edges same).
            const pts = collectTargetPropFrames(t, target);
            applyKeyframeMoves(t, pts.map((p) => ({
              target,
              prop: p.prop,
              from: p.frame,
              to: nMin,
            })));
            return;
          }
          if (nMax === nMin) nMax = nMin + 1;
          const pts = collectTargetPropFrames(t, target);
          const moves: KeyframeMove[] = pts.map((p) => {
            const ratio = (p.frame - oldMin) / oldRange;
            const to = Math.round(nMin + ratio * (nMax - nMin));
            return { target, prop: p.prop, from: p.frame, to: Math.max(0, to) };
          });
          // Ensure per-prop uniqueness after rounding.
          const byProp = new Map<AnimatableProp, KeyframeMove[]>();
          for (const m of moves) {
            const list = byProp.get(m.prop) ?? [];
            list.push(m);
            byProp.set(m.prop, list);
          }
          const fixed: KeyframeMove[] = [];
          for (const [, list] of byProp) {
            list.sort((a, b) => a.from - b.from);
            for (let i = 1; i < list.length; i++) {
              if (list[i]!.to <= list[i - 1]!.to) list[i]!.to = list[i - 1]!.to + 1;
            }
            fixed.push(...list);
          }
          applyKeyframeMoves(t, fixed);
        });
      },

      shiftSelectedKeyframes: (selected, deltaFrames) => {
        if (deltaFrames === 0 || selected.length === 0) return selected;
        let result: SelectedKeyframeRef[] | null = selected;
        get().patch((t) => {
          const selectedKeys = new Set(
            selected.map((s) => `${s.target.kind}:${s.target.id}:${s.prop}:${s.frame}`),
          );
          const moves: KeyframeMove[] = selected.map((s) => ({
            target: s.target,
            prop: s.prop,
            from: s.frame,
            to: Math.max(0, s.frame + deltaFrames),
          }));

          // Collision with non-selected keyframes of same prop → abort.
          for (const m of moves) {
            const destKey = `${m.target.kind}:${m.target.id}:${m.prop}:${m.to}`;
            if (selectedKeys.has(`${m.target.kind}:${m.target.id}:${m.prop}:${m.from}`)
              && moves.some((o) => o.target.kind === m.target.kind && o.target.id === m.target.id
                && o.prop === m.prop && o.from === m.to)) {
              continue; // destination occupied by another selected move — OK (two-phase)
            }
            const occupied = readPropValue(t, m.target, m.prop, m.to);
            if (occupied === undefined) continue;
            const isSelectedDest = selectedKeys.has(destKey);
            if (!isSelectedDest) {
              result = null;
              return;
            }
          }
          if (result === null) return;

          // Per-prop uniqueness after move.
          const byProp = new Map<string, KeyframeMove[]>();
          for (const m of moves) {
            const key = `${m.target.kind}:${m.target.id}:${m.prop}`;
            const list = byProp.get(key) ?? [];
            list.push(m);
            byProp.set(key, list);
          }
          const fixed: KeyframeMove[] = [];
          for (const [, list] of byProp) {
            list.sort((a, b) => a.from - b.from);
            for (let i = 1; i < list.length; i++) {
              if (list[i]!.to <= list[i - 1]!.to) list[i]!.to = list[i - 1]!.to + 1;
            }
            fixed.push(...list);
          }
          applyKeyframeMoves(t, fixed);
          result = fixed.map((m) => ({ target: m.target, prop: m.prop, frame: m.to }));
        });
        return result;
      },

      deletePoint: (target, prop, frame) =>
        get().patch((t) => {
          const kf = t.timeline.keyframes.find((k) => k.frame === frame);
          if (!kf) return;
          const sec = target.kind === 'layer' ? kf.layers : kf.groups;
          const bag = sec[target.id];
          if (!bag) return;
          delete bag[prop];
          if (Object.keys(bag).length === 0) delete sec[target.id];
          pruneKf(t, kf);
        }),

      removeTrack: (target, prop) =>
        get().patch((t) => {
          for (const kf of t.timeline.keyframes) {
            const sec = target.kind === 'layer' ? kf.layers : kf.groups;
            const bag = sec[target.id];
            if (!bag || bag[prop] === undefined) continue;
            delete bag[prop];
            if (Object.keys(bag).length === 0) delete sec[target.id];
            pruneKf(t, kf);
          }
          delete t.timeline.trackDirectors[trackKey(target, prop)];
          delete t.timeline.trackDirectors[target.id];
          removeFromTrackOrder(t, trackKey(target, prop));
        }),

      setKeyframeEasing: (frame, easing) =>
        get().patch((t) => {
          const kf = t.timeline.keyframes.find((k) => k.frame === frame);
          if (kf) { kf.easing = easing; delete kf.bezier; }
        }),

      addTrackAtPlayhead: (target, prop) => {
        const st = get();
        const ph = st.playheads[st.activeDirectorId] ?? 0;
        get().patch((t) => {
          const did = ensureDefaultDirector(t);
          const directorId = st.activeDirectorId || did;
          const kf = kfAt(t, ph);
          const sec = target.kind === 'layer' ? kf.layers : kf.groups;
          (sec[target.id] ??= {})[prop] = baseValue(t, target, prop);
          assignTrackDirector(t, { target, prop }, directorId);
          appendTrackOrder(t, directorId, trackKey(target, prop));
        });
      },
    }),
    {
      limit: 100,
      partialize: (s) => ({ template: s.template }),
      equality: (a, b) => a.template === b.template,
    },
  ),
);

// --- temporal (undo/redo) reactive helpers -------------------------------
export function useCanUndo(): boolean {
  return useStore(useEditor.temporal, (s) => s.pastStates.length > 0);
}
export function useCanRedo(): boolean {
  return useStore(useEditor.temporal, (s) => s.futureStates.length > 0);
}
export function undo(): void {
  useEditor.temporal.getState().undo();
}
export function redo(): void {
  useEditor.temporal.getState().redo();
}
