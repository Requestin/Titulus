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
} from '@runtime';
import {
  ANIMATABLE_PROPS,
  createDefaultTransform,
  estimateCrawlDurationFrames,
  normalizeTemplateTextStyles,
  resolveTrackDirector,
  splitCrawlLines,
} from '@runtime';
import { createId } from '@/core/id';
import { createLayer, createVariable, LAYER_LABEL } from './factories';
import { reparentEntriesIntoGroup } from './groupBounds';
import { recomputeCrawlDirectorDuration, removeCrawlDirector, ensureCrawlProgressTrack } from './crawlTimeline';
import { trackKey, type TimelineTrack } from './timelineTracks';

export type Selection = { kind: 'layer' | 'group'; id: string } | null;
export type Target = { kind: 'layer' | 'group'; id: string };

function baseValue(t: Template, target: Target, prop: AnimatableProp): number {
  if (prop === 'crawlProgress') return 0;
  if (target.kind === 'layer') {
    const l = t.layers.find((x) => x.id === target.id);
    if (!l) return 0;
    if (prop === 'opacity') return l.opacity;
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

  // timeline + playback (playheads/playing/activeDirectorId are transient)
  playheads: Record<string, number>;
  /** Per-director elapsed rel time for loop/swing playback (transient). */
  directorRel: Record<string, number>;
  playing: boolean;
  activeDirectorId: string;
  setPlayhead: (directorId: string, frame: number) => void;
  setPlayheads: (playheads: Record<string, number>) => void;
  /** Set the same local frame on every director (global scrub). */
  setGlobalPlayhead: (frame: number) => void;
  setDirectorRel: (directorId: string, rel: number) => void;
  setPlaying: (playing: boolean) => void;
  setActiveDirector: (id: string) => void;
  setTimelineMeta: (partial: { fps?: number; durationFrames?: number; playbackMode?: 'bounded' | 'infinite' }) => void;
  addDirector: () => void;
  updateDirector: (id: string, partial: Partial<TimelineDirector>) => void;
  removeDirector: (id: string) => void;
  assignTrack: (track: TimelineTrack, directorId: string) => void;
  reorderTracks: (directorId: string, trackKeys: string[]) => void;
  moveTrackToDirector: (track: TimelineTrack, toDirectorId: string, toIndex?: number) => void;
  setKeyframeValue: (target: Target, frame: number, prop: AnimatableProp, value: number, directorId?: string) => void;
  movePoint: (target: Target, prop: AnimatableProp, fromFrame: number, toFrame: number) => void;
  moveKeyframeSegment: (target: Target, prop: AnimatableProp, edgeIndex: number, deltaFrames: number) => void;
  deletePoint: (target: Target, prop: AnimatableProp, frame: number) => void;
  removeTrack: (target: Target, prop: AnimatableProp) => void;
  setKeyframeEasing: (frame: number, easing: EasingType) => void;
  addTrackAtPlayhead: (target: Target, prop: AnimatableProp) => void;
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
      activeDirectorId: 'default',

      load: (t) => {
        const normalized = clone(t);
        normalizeTemplateTextStyles(normalized);
        for (const g of normalized.groups) {
          g.transform.width = 0;
          g.transform.height = 0;
        }
        set({
          template: normalized,
          selection: null,
          dirty: false,
          playheads: initPlayheads(normalized.timeline.directors),
          directorRel: initPlayheads(normalized.timeline.directors),
          playing: false,
          activeDirectorId: t.timeline.directors[0]?.id ?? 'default',
        });
        useEditor.temporal.getState().clear();
      },
      markSaved: () => set({ dirty: false }),
      select: (sel) => set({ selection: sel }),
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
        }),

      removeVariable: (id) =>
        get().patch((t) => { t.variables = t.variables.filter((v) => v.id !== id); }),

      // --- timeline + playback ---
      setPlayhead: (directorId, frame) =>
        set((s) => ({
          playheads: { ...s.playheads, [directorId]: Math.max(0, Math.round(frame)) },
          directorRel: { ...s.directorRel, [directorId]: Math.max(0, Math.round(frame)) },
        })),
      setPlayheads: (playheads) => set({ playheads }),
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
        if (!playing) return { playing: false };
        const t = get().template;
        const directorRel = { ...s.directorRel };
        for (const d of t?.timeline.directors ?? []) {
          directorRel[d.id] = s.playheads[d.id] ?? 0;
        }
        return { playing: true, directorRel };
      }),
      setActiveDirector: (id) => set({ activeDirectorId: id, playing: false }),

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
          if (d) Object.assign(d, partial);
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
          t.timeline.actions = t.timeline.actions.filter((a) => a.directorId !== id);
        });

        const next = get().template?.timeline.directors[0]?.id;
        set((s) => {
          const playheads = { ...s.playheads };
          const directorRel = { ...s.directorRel };
          delete playheads[id];
          delete directorRel[id];
          return {
            activeDirectorId: s.activeDirectorId === id ? (next ?? 'default') : s.activeDirectorId,
            playheads,
            directorRel,
          };
        });
      },

      assignTrack: (track, directorId) =>
        get().patch((t) => {
          assignTrackDirector(t, track, directorId);
          appendTrackOrder(t, directorId, trackKey(track.target, track.prop));
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
          const from = t.timeline.keyframes.find((k) => k.frame === fromFrame);
          if (!from) return;
          const sec = target.kind === 'layer' ? from.layers : from.groups;
          const bag = sec[target.id];
          if (!bag || bag[prop] === undefined) return;
          const val = bag[prop] as number;
          delete bag[prop];
          if (Object.keys(bag).length === 0) delete sec[target.id];
          pruneKf(t, from);
          const to = kfAt(t, Math.round(toFrame));
          const tsec = target.kind === 'layer' ? to.layers : to.groups;
          (tsec[target.id] ??= {})[prop] = val;
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
          const delta = deltaFrames;

          const targetFrames = moving.map((f) => Math.max(0, f + delta));
          for (let i = 1; i < targetFrames.length; i++) {
            if (targetFrames[i]! <= targetFrames[i - 1]!) targetFrames[i] = targetFrames[i - 1]! + 1;
          }
          for (const tf of targetFrames) {
            if (fixed.has(tf)) return;
          }

          const frameMap = new Map(moving.map((f, i) => [f, targetFrames[i]!]));
          for (const [from, to] of frameMap) {
            if (from === to) continue;
            const kfFrom = t.timeline.keyframes.find((k) => k.frame === from);
            if (!kfFrom) continue;
            const sec = target.kind === 'layer' ? kfFrom.layers : kfFrom.groups;
            const bag = sec[target.id];
            if (!bag || bag[prop] === undefined) continue;
            const val = bag[prop] as number;
            delete bag[prop];
            if (Object.keys(bag).length === 0) delete sec[target.id];
            pruneKf(t, kfFrom);
            const kfTo = kfAt(t, to);
            const tsec = target.kind === 'layer' ? kfTo.layers : kfTo.groups;
            (tsec[target.id] ??= {})[prop] = val;
          }
        });
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
