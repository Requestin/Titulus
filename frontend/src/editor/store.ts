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
  TimelineCue, TimelineCueCommand, TimelineCueItem,
} from '@runtime';
import { ANIMATABLE_PROPS, createDefaultTransform, ensureUpdateDirector } from '@runtime';
import { createId } from '@/core/id';
import { createLayer, createVariable, LAYER_LABEL } from './factories';
import { attachAllCrawlTimelines, attachCrawlTimeline } from './crawlTimeline';
import { effectiveAnimatableValues, effectiveTransform } from './effectiveValues';
import { ancestorMatrix, reparentTransform } from './transformMath';
import { applyClonedTree, cloneTreeSelection, normalizeTreeSelection, type TreeRef } from './treeClipboard';
import { playheadStore, scrubGlobalPlayhead, syncGlobalPlayhead, syncPlayhead, setLivePlaying, activateDirectorPlayhead } from './playheadStore';
import { applyObjectStretch } from './timelineSummary';
import { offsetDirectChildren } from './groupBounds';
import {
  applyKeyframeMoves,
  assignPropertyDirector as writePropertyDirector,
  bagFor,
  erasePoint,
  keyframeBelongsToDirector,
  keyframeScopeForWrite,
  planKeyframeMoves,
  retargetSelected,
  tracksForDirector,
  type SelectedKeyframe,
} from './timelineTracks';
import {
  canRemoveDirector,
  constrainCueTag,
  createCue,
  createCueItem,
  cueFrameFromEffective,
  findCueAtEffectiveFrame,
  isProtectedUpdateDirector,
  mergeCueItems,
  stripCuesForDirector,
} from './timelineCues';

export type Selection = { kind: 'layer' | 'group'; id: string } | null;
export type Target = { kind: 'layer' | 'group'; id: string };
export type { SelectedKeyframe };

function currentPlayhead(): number {
  return playheadStore.getState().playhead;
}

function gradientWeightKey(
  prop: AnimatableProp,
): 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight' | null {
  if (prop === 'gradient.weights.topLeft') return 'topLeft';
  if (prop === 'gradient.weights.topRight') return 'topRight';
  if (prop === 'gradient.weights.bottomLeft') return 'bottomLeft';
  if (prop === 'gradient.weights.bottomRight') return 'bottomRight';
  return null;
}

function baseValue(t: Template, target: Target, prop: AnimatableProp): number {
  if (target.kind === 'layer') {
    const l = t.layers.find((x) => x.id === target.id);
    if (!l) return 0;
    if (prop === 'opacity') return l.opacity;
    const weight = gradientWeightKey(prop);
    if (weight && l.type === 'rect' && l.gradient) return l.gradient.weights[weight];
    return (l.transform as unknown as Record<string, number>)[prop] ?? 0;
  }
  const g = t.groups.find((x) => x.id === target.id);
  if (!g) return prop === 'opacity' ? 1 : 0;
  if (prop === 'opacity') return 1;
  return (g.transform as unknown as Record<string, number>)[prop] ?? 0;
}

function kfAt(t: Template, frame: number, directorId?: string): TimelineKeyframe {
  let kf = t.timeline.keyframes.find((k) => k.frame === frame && (k.directorId ?? undefined) === directorId);
  if (!kf) {
    kf = { id: createId(), frame, layers: {}, groups: {}, easing: 'power2.out' };
    if (directorId) kf.directorId = directorId;
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

const ANIMATABLE_SET = new Set<string>([...ANIMATABLE_PROPS, 'z']);

function hasAnimatedProp(t: Template, target: Target, prop: AnimatableProp, directorId?: string): boolean {
  return t.timeline.keyframes.some((k) => (
    directorId
      ? keyframeBelongsToDirector(t.timeline, k, target, prop, directorId)
      : bagFor(k, target)?.[prop] !== undefined
  ));
}

/** Write only tracked values into a keyframe at the current playhead. */
function writeTrackedPropsAtPlayhead(
  t: Template,
  target: Target,
  values: Partial<Record<AnimatableProp, number>>,
  localFrame: number,
  directorId: string,
): void {
  const frame = Math.round(localFrame);
  for (const [prop, value] of Object.entries(values) as [AnimatableProp, number][]) {
    if (value === undefined || !hasAnimatedProp(t, target, prop, directorId)) continue;
    const kf = kfAt(t, frame, keyframeScopeForWrite(t, target, prop, directorId));
    const sec = target.kind === 'layer' ? kf.layers : kf.groups;
    (sec[target.id] ??= {})[prop] = value;
  }
}

function editTransformAtPlayhead(
  t: Template,
  target: Target,
  partial: Partial<Transform>,
  localFrame: number,
  directorId: string,
): void {
  const entity = target.kind === 'layer'
    ? t.layers.find((item) => item.id === target.id)
    : t.groups.find((item) => item.id === target.id);
  if (!entity) return;
  for (const [key, value] of Object.entries(partial) as [keyof Transform, number][]) {
    if (value === undefined) continue;
    if (ANIMATABLE_SET.has(key) && hasAnimatedProp(t, target, key as AnimatableProp, directorId)) {
      writeTrackedPropsAtPlayhead(t, target, { [key]: value } as Partial<Record<AnimatableProp, number>>, localFrame, directorId);
    } else {
      entity.transform[key] = value;
    }
  }
}

function editOpacityAtPlayhead(t: Template, id: string, opacity: number, localFrame: number, directorId: string): void {
  const target: Target = { kind: 'layer', id };
  if (hasAnimatedProp(t, target, 'opacity', directorId)) {
    writeTrackedPropsAtPlayhead(t, target, { opacity }, localFrame, directorId);
    return;
  }
  const layer = t.layers.find((item) => item.id === id);
  if (layer) layer.opacity = opacity;
}

/**
 * Keep an entry in the same world-space position while changing its parent.
 * The transform model represents translate/rotate/scale (not skew), which is
 * exact for the editor's normal group hierarchy.
 */
export function reparentTargetAtPlayhead(
  t: Template,
  target: Target,
  newParentId: string | null,
  localFrame: number,
  directorId: string,
): void {
  const entity = target.kind === 'layer'
    ? t.layers.find((item) => item.id === target.id)
    : t.groups.find((item) => item.id === target.id);
  if (!entity) return;
  const effective = effectiveTransform(t, entity.transform, target, localFrame, directorId);
  const oldParentId = target.kind === 'layer'
    ? (entity as Layer).groupId
    : (entity as import('@runtime').LayerGroup).parentId;
  const resolveGroupTransform = (group: import('@runtime').LayerGroup) =>
    effectiveTransform(t, group.transform, { kind: 'group', id: group.id }, localFrame, directorId);
  const oldParentMatrix = ancestorMatrix(t, oldParentId, resolveGroupTransform);
  const newParentMatrix = ancestorMatrix(
    t,
    newParentId,
    resolveGroupTransform,
  );
  editTransformAtPlayhead(t, target, reparentTransform(effective, newParentMatrix, oldParentMatrix), localFrame, directorId);
}

interface EditorState {
  template: Template | null;
  selection: Selection;
  checked: TreeRef[];
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
  updateGroupPivot: (id: string, partial: Partial<Transform>) => void;
  setName: (name: string) => void;
  setCanvas: (partial: Partial<Template['canvas']>) => void;
  addLayer: (type: LayerType) => void;
  duplicateSelected: () => void;
  toggleChecked: (ref: TreeRef) => void;
  clearChecked: () => void;
  deleteSelected: () => void;
  toggleVisible: (kind: 'layer' | 'group', id: string) => void;
  toggleLock: (kind: 'layer' | 'group', id: string) => void;
  setLayerGroup: (layerId: string, groupId: string | null) => void;
  addGroup: () => void;
  reorderContainer: (containerId: string | null, ids: string[]) => void;

  addVariable: () => void;
  updateVariable: (id: string, partial: Partial<Variable>) => void;
  removeVariable: (id: string) => void;

  // timeline + playback (playhead/playing/selection are transient)
  playhead: number;
  playing: boolean;
  activeDirectorId: string;
  selectedKeyframes: SelectedKeyframe[];
  selectedCueId: string | null;
  setPlayhead: (frame: number) => void;
  setPlaying: (playing: boolean) => void;
  setActiveDirector: (id: string) => void;
  setSelectedKeyframes: (keyframes: SelectedKeyframe[]) => void;
  clearSelectedKeyframes: () => void;
  assignPropertyDirector: (target: Target, prop: AnimatableProp, directorId: string) => void;
  assignTracksToDirector: (tracks: Array<{ target: Target; prop: AnimatableProp }>, directorId: string) => void;
  moveSelectedKeyframes: (deltaFrames: number) => void;
  stretchObjectSummary: (target: Target, edge: 'start' | 'end', newEdgeFrame: number) => void;
  addKeyframeAtPlayhead: (target: Target, prop: AnimatableProp) => void;
  deleteSelectedKeyframes: () => void;
  setTimelineMeta: (partial: { fps?: number; durationFrames?: number; playbackMode?: 'bounded' | 'infinite' }) => void;
  addDirector: () => void;
  updateDirector: (id: string, partial: Partial<TimelineDirector>) => void;
  removeDirector: (id: string) => void;
  assignTrack: (targetId: string, directorId: string) => void;
  setKeyframeValue: (target: Target, frame: number, prop: AnimatableProp, value: number) => void;
  commitCurveDrag: (target: Target, prop: AnimatableProp, fromFrame: number, nextFrame: number, value: number) => void;
  movePoint: (target: Target, prop: AnimatableProp, fromFrame: number, toFrame: number) => void;
  deletePoint: (target: Target, prop: AnimatableProp, frame: number) => void;
  removeTrack: (target: Target, prop: AnimatableProp) => void;
  setKeyframeEasing: (target: Target, prop: AnimatableProp, frame: number, easing: EasingType) => void;
  addTrackAtPlayhead: (target: Target, prop: AnimatableProp) => void;
  selectCue: (id: string | null) => void;
  addCueAtPlayhead: () => void;
  removeSelectedCue: () => void;
  moveCue: (cueId: string, effectiveFrame: number) => void;
  updateCue: (cueId: string, partial: Partial<Pick<TimelineCue, 'name' | 'fromEnd' | 'frame'>>) => void;
  addCueItem: (cueId: string, command?: TimelineCueCommand) => void;
  removeCueItem: (cueId: string, itemId: string) => void;
  updateCueItem: (cueId: string, itemId: string, next: TimelineCueItem) => void;
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
      checked: [],
      dirty: false,
      zoom: 0.45,
      gridSnap: false,
      gridSize: 8,
      playhead: 0,
      playing: false,
      activeDirectorId: 'default',
      selectedKeyframes: [],
      selectedCueId: null,

      load: (t) => {
        attachAllCrawlTimelines(t);
        ensureUpdateDirector(t.timeline);
        syncPlayhead(0, false);
        set({
          template: t,
          selection: null,
          checked: [],
          dirty: false,
          playhead: 0,
          playing: false,
          activeDirectorId: t.timeline.directors[0]?.id ?? 'default',
          selectedKeyframes: [],
          selectedCueId: null,
        });
        useEditor.temporal.getState().clear();
      },
      markSaved: () => set({ dirty: false }),
      select: (sel) => {
        const template = get().template;
        if (sel?.kind === 'layer' && template) {
          const layer = template.layers.find((item) => item.id === sel.id);
          if (layer?.type === 'crawl' && layer.crawlDirectorId) {
            const duration = template.timeline.directors.find((item) => item.id === layer.crawlDirectorId)?.durationFrames
              ?? get().playhead;
            set({
              selection: sel,
              activeDirectorId: layer.crawlDirectorId,
              playhead: Math.min(get().playhead, Math.max(0, duration)),
            });
            return;
          }
        }
        set({ selection: sel });
      },
      toggleChecked: (ref) => set((s) => {
        const exists = s.checked.some((item) => item.kind === ref.kind && item.id === ref.id);
        return {
          checked: exists
            ? s.checked.filter((item) => item.kind !== ref.kind || item.id !== ref.id)
            : [...s.checked, ref],
        };
      }),
      clearChecked: () => set({ checked: [] }),
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
          if (l.type === 'crawl') attachCrawlTimeline(t, l);
        }),

      setLayerOpacity: (id, opacity) =>
        get().patch((t) => {
          editOpacityAtPlayhead(t, id, Math.min(1, Math.max(0, opacity)), currentPlayhead(), get().activeDirectorId);
        }),

      updateTransform: (id, partial, kind = 'layer') =>
        get().patch((t) => {
          editTransformAtPlayhead(t, { kind, id }, partial, currentPlayhead(), get().activeDirectorId);
          if (kind === 'layer') {
            const layer = t.layers.find((item) => item.id === id);
            if (layer?.type === 'crawl') attachCrawlTimeline(t, layer);
          }
        }),

      updateGroupPivot: (id, partial) =>
        get().patch((t) => {
          const group = t.groups.find((item) => item.id === id);
          if (!group) return;
          const ph = currentPlayhead();
          const directorId = get().activeDirectorId;
          const live = effectiveTransform(t, group.transform, { kind: 'group', id }, ph, directorId);
          const oldLeft = live.x - live.width * live.anchorX;
          const oldTop = live.y - live.height * live.anchorY;
          editTransformAtPlayhead(t, { kind: 'group', id }, partial, ph, directorId);
          const next = { ...live, ...partial };
          offsetDirectChildren(
            t,
            id,
            oldLeft - (next.x - next.width * next.anchorX),
            oldTop - (next.y - next.height * next.anchorY),
          );
        }),

      setName: (name) => get().patch((t) => { t.name = name; }),
      setCanvas: (partial) => get().patch((t) => { Object.assign(t.canvas, partial); }),

      addLayer: (type) => {
        const t0 = get().template;
        if (!t0) return;
        const n = t0.layers.filter((l) => l.type === type).length + 1;
        const layer = createLayer(type, `${LAYER_LABEL[type]} ${n}`);
        get().patch((t) => {
          t.layers.push(layer);
          t.rootStack.push({ kind: 'layer', id: layer.id });
          if (layer.type === 'crawl') attachCrawlTimeline(t, layer);
        });
        get().select({ kind: 'layer', id: layer.id });
      },

      duplicateSelected: () => {
        const { selection, template, checked } = get();
        if (!template) return;
        const sources = checked.length > 0 ? checked : (selection ? [selection] : []);
        const roots = normalizeTreeSelection(template, sources);
        if (roots.length === 0) return;
        let next: Selection = null;
        get().patch((t) => {
          const cloned = cloneTreeSelection(t, roots, { createId, offset: { x: 24, y: 24 } });
          applyClonedTree(t, cloned);
          next = cloned.roots[0] ?? null;
        });
        if (next) set({ selection: next });
      },

      deleteSelected: () => {
        const sel = get().selection;
        if (!sel) return;
        get().patch((t) => {
          const orphanDirectorIds = sel.kind === 'layer'
            ? t.layers
              .filter((layer): layer is Extract<typeof layer, { type: 'crawl' }> => layer.id === sel.id && layer.type === 'crawl')
              .map((layer) => layer.crawlDirectorId)
            : [];
          if (sel.kind === 'layer') {
            t.layers = t.layers.filter((l) => l.id !== sel.id);
          } else {
            // Re-parent the group's children to root, then drop the group.
            const children = t.groupStacks[sel.id] ?? [];
            for (const c of children) {
              if (c.kind === 'layer') {
                const l = t.layers.find((x) => x.id === c.id);
                if (l) {
                  reparentTargetAtPlayhead(t, c, null, get().playhead, get().activeDirectorId);
                  l.groupId = null;
                }
              } else {
                const g = t.groups.find((x) => x.id === c.id);
                if (g) {
                  reparentTargetAtPlayhead(t, c, null, get().playhead, get().activeDirectorId);
                  g.parentId = null;
                }
              }
              t.rootStack.push(c);
            }
            delete t.groupStacks[sel.id];
            t.groups = t.groups.filter((g) => g.id !== sel.id);
          }
          removeEntryEverywhere(t, sel.id);
          delete t.timeline.trackDirectors[sel.id];
          if (t.timeline.propertyTrackDirectors) {
            delete t.timeline.propertyTrackDirectors[sel.id];
            if (Object.keys(t.timeline.propertyTrackDirectors).length === 0) {
              delete t.timeline.propertyTrackDirectors;
            }
          }
          for (const kf of t.timeline.keyframes) {
            delete kf.layers[sel.id];
            delete kf.groups[sel.id];
          }
          for (const directorId of orphanDirectorIds) {
            const stillUsed = t.layers.some((layer) => layer.type === 'crawl' && layer.crawlDirectorId === directorId);
            if (!stillUsed) {
              t.timeline.directors = t.timeline.directors.filter((director) => director.id !== directorId);
              t.timeline.cues = stripCuesForDirector(t.timeline, directorId);
            }
          }
        });
        set({ selection: null });
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
          reparentTargetAtPlayhead(t, { kind: 'layer', id: layerId }, groupId, get().playhead, get().activeDirectorId);
          l.groupId = groupId;
          removeEntryEverywhere(t, layerId);
          addEntry(t, { kind: 'layer', id: layerId }, groupId);
        }),

      addGroup: () => {
        const t0 = get().template;
        if (!t0) return;
        const n = t0.groups.length + 1;
        const id = createId();
        get().patch((t) => {
          t.groups.push({
            id, name: `Group ${n}`, parentId: null, visible: true, locked: false,
            transform: createDefaultTransform(0, 0),
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
      setPlayhead: (frame) => {
        const playhead = Math.max(0, Math.round(frame));
        const tpl = get().template;
        const directors = tpl?.timeline.directors ?? [];
        const dir = directors.find((d) => d.id === get().activeDirectorId);
        const global = (dir?.offsetFrames ?? 0) + playhead;
        if (tpl) scrubGlobalPlayhead(global, directors, get().activeDirectorId);
        else {
          syncPlayhead(playhead, playheadStore.getState().playing);
          syncGlobalPlayhead(global);
        }
        set({ playhead, playing: false });
      },
      setPlaying: (playing) => {
        // Play arming is owned by requestEditorPlay / preparePlayStart.
        // Only clear the live flag here on pause/stop — never re-assert true
        // (that raced the RAF loop after Go-to-start → Play).
        if (!playing) setLivePlaying(false);
        set({ playing });
      },
      setActiveDirector: (id) => {
        const tpl = get().template;
        const directors = tpl?.timeline.directors ?? [];
        if (tpl) activateDirectorPlayhead(id, directors);
        else syncPlayhead(playheadStore.getState().playhead, false);
        setLivePlaying(false);
        set({ activeDirectorId: id, playhead: playheadStore.getState().playhead, playing: false });
      },
      setSelectedKeyframes: (keyframes) => set({ selectedKeyframes: keyframes, selectedCueId: keyframes.length ? null : get().selectedCueId }),
      clearSelectedKeyframes: () => set({ selectedKeyframes: [] }),
      selectCue: (id) => set({ selectedCueId: id, selectedKeyframes: id ? [] : get().selectedKeyframes }),

      setTimelineMeta: (partial) => get().patch((t) => {
        Object.assign(t.timeline, partial);
        if (partial.fps != null) attachAllCrawlTimelines(t);
      }),

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
        });
        syncPlayhead(0, false);
        set({ activeDirectorId: id, playhead: 0 });
      },

      updateDirector: (id, partial) =>
        get().patch((t) => {
          const d = t.timeline.directors.find((x) => x.id === id);
          if (!d) return;
          if (isProtectedUpdateDirector(d) && partial.name !== undefined) {
            const { name: _ignored, ...rest } = partial;
            Object.assign(d, rest);
          } else {
            Object.assign(d, partial);
          }
          const crawl = t.layers.find((layer) => layer.type === 'crawl' && layer.crawlDirectorId === id);
          if (crawl && crawl.type === 'crawl') attachCrawlTimeline(t, crawl);
        }),

      removeDirector: (id) => {
        const t0 = get().template;
        if (!t0 || !canRemoveDirector(t0.timeline.directors, id)) return;
        if (t0.layers.some((layer) => layer.type === 'crawl' && layer.crawlDirectorId === id)) return;
        get().patch((t) => {
          t.timeline.directors = t.timeline.directors.filter((d) => d.id !== id);
          for (const k of Object.keys(t.timeline.trackDirectors)) {
            if (t.timeline.trackDirectors[k] === id) delete t.timeline.trackDirectors[k];
          }
          t.timeline.actions = t.timeline.actions.filter((a) => a.directorId !== id);
          t.timeline.cues = stripCuesForDirector(t.timeline, id);
          if (t.timeline.propertyTrackDirectors) {
            for (const [targetId, bag] of Object.entries(t.timeline.propertyTrackDirectors)) {
              for (const [prop, directorId] of Object.entries(bag ?? {})) {
                if (directorId === id) delete bag![prop as AnimatableProp];
              }
              if (bag && Object.keys(bag).length === 0) delete t.timeline.propertyTrackDirectors[targetId];
            }
            if (Object.keys(t.timeline.propertyTrackDirectors).length === 0) {
              delete t.timeline.propertyTrackDirectors;
            }
          }
        });
        if (get().activeDirectorId === id) {
          syncPlayhead(0, false);
          set({ activeDirectorId: get().template?.timeline.directors[0]?.id ?? 'default', playhead: 0 });
        }
      },

      assignTrack: (targetId, directorId) =>
        get().patch((t) => { t.timeline.trackDirectors[targetId] = directorId; }),

      assignPropertyDirector: (target, prop, directorId) =>
        get().patch((t) => {
          if (!t.timeline.trackDirectors[target.id]) t.timeline.trackDirectors[target.id] = get().activeDirectorId;
          writePropertyDirector(t.timeline, target, prop, directorId);
        }),

      assignTracksToDirector: (tracks, directorId) =>
        get().patch((t) => {
          for (const track of tracks) {
            if (!t.timeline.trackDirectors[track.target.id]) t.timeline.trackDirectors[track.target.id] = directorId;
            writePropertyDirector(t.timeline, track.target, track.prop, directorId);
          }
        }),

      moveSelectedKeyframes: (deltaFrames) => {
        const selected = get().selectedKeyframes;
        const template = get().template;
        if (!template || selected.length === 0) return;
        const moves = planKeyframeMoves(template, selected, deltaFrames);
        if (moves.length === 0) return;
        get().patch((t) => { applyKeyframeMoves(t, moves); });
        set({ selectedKeyframes: retargetSelected(selected, moves) });
      },

      stretchObjectSummary: (target, edge, newEdgeFrame) =>
        get().patch((t) => { applyObjectStretch(t, target, edge, newEdgeFrame); }),

      addKeyframeAtPlayhead: (target, prop) => {
        const ph = currentPlayhead();
        const directorId = get().activeDirectorId;
        get().patch((t) => {
          const sampled = hasAnimatedProp(t, target, prop, directorId)
            ? effectiveAnimatableValues(t, target, ph, directorId)[prop]
            : undefined;
          const kf = kfAt(t, ph, keyframeScopeForWrite(t, target, prop, directorId));
          const sec = target.kind === 'layer' ? kf.layers : kf.groups;
          (sec[target.id] ??= {})[prop] = sampled ?? baseValue(t, target, prop);
          if (!t.timeline.trackDirectors[target.id]) t.timeline.trackDirectors[target.id] = directorId;
        });
      },

      deleteSelectedKeyframes: () => {
        const selected = get().selectedKeyframes;
        if (selected.length === 0) return;
        get().patch((t) => {
          for (const key of selected) erasePoint(t, key.target, key.frame, key.prop, key.directorId);
        });
        set({ selectedKeyframes: [] });
      },

      setKeyframeValue: (target, frame, prop, value) =>
        get().patch((t) => {
          const directorId = get().activeDirectorId;
          const kf = kfAt(t, Math.round(frame), keyframeScopeForWrite(t, target, prop, directorId));
          const sec = target.kind === 'layer' ? kf.layers : kf.groups;
          (sec[target.id] ??= {})[prop] = value;
          if (!t.timeline.trackDirectors[target.id]) t.timeline.trackDirectors[target.id] = directorId;
        }),

      commitCurveDrag: (target, prop, fromFrame, nextFrame, value) =>
        get().patch((t) => {
          const directorId = get().activeDirectorId;
          const scope = keyframeScopeForWrite(t, target, prop, directorId);
          const kf = kfAt(t, Math.round(fromFrame), scope);
          const sec = target.kind === 'layer' ? kf.layers : kf.groups;
          (sec[target.id] ??= {})[prop] = value;
          if (!t.timeline.trackDirectors[target.id]) t.timeline.trackDirectors[target.id] = directorId;
          if (nextFrame === fromFrame) return;
          const moves = planKeyframeMoves(t, [{ target, prop, frame: fromFrame, directorId: scope }], nextFrame - fromFrame);
          if (moves.length > 0) applyKeyframeMoves(t, moves);
        }),

      movePoint: (target, prop, fromFrame, toFrame) => {
        const template = get().template;
        if (!template || fromFrame === toFrame) return;
        const directorId = get().activeDirectorId;
        const scope = keyframeScopeForWrite(template, target, prop, directorId);
        const moves = planKeyframeMoves(template, [{ target, prop, frame: fromFrame, directorId: scope }], toFrame - fromFrame);
        if (moves.length === 0) return;
        get().patch((t) => { applyKeyframeMoves(t, moves); });
      },

      deletePoint: (target, prop, frame) =>
        get().patch((t) => {
          const directorId = get().activeDirectorId;
          const scope = keyframeScopeForWrite(t, target, prop, directorId);
          const kf = t.timeline.keyframes.find((k) => k.frame === frame && (k.directorId ?? undefined) === scope);
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
          const directorId = get().activeDirectorId;
          for (const kf of [...t.timeline.keyframes]) {
            if (!keyframeBelongsToDirector(t.timeline, kf, target, prop, directorId)) continue;
            const sec = target.kind === 'layer' ? kf.layers : kf.groups;
            const bag = sec[target.id];
            if (!bag || bag[prop] === undefined) continue;
            delete bag[prop];
            if (Object.keys(bag).length === 0) delete sec[target.id];
            pruneKf(t, kf);
          }
          if (t.timeline.propertyTrackDirectors?.[target.id]?.[prop] === directorId) {
            writePropertyDirector(t.timeline, target, prop, t.timeline.trackDirectors[target.id] ?? 'default');
          }
          const stillAnimated = t.timeline.keyframes.some((k) => {
            const bag = (target.kind === 'layer' ? k.layers : k.groups)[target.id];
            return bag && Object.keys(bag).length > 0;
          });
          if (!stillAnimated) {
            delete t.timeline.trackDirectors[target.id];
            if (t.timeline.propertyTrackDirectors) {
              delete t.timeline.propertyTrackDirectors[target.id];
              if (Object.keys(t.timeline.propertyTrackDirectors).length === 0) {
                delete t.timeline.propertyTrackDirectors;
              }
            }
          }
        }),

      setKeyframeEasing: (target, prop, frame, easing) =>
        get().patch((t) => {
          const directorId = get().activeDirectorId;
          const scope = keyframeScopeForWrite(t, target, prop, directorId);
          const kf = t.timeline.keyframes.find((k) => k.frame === frame && (k.directorId ?? undefined) === scope);
          if (!kf) return;
          const bag = target.kind === 'layer' ? kf.layers[target.id] : kf.groups[target.id];
          if (!bag || bag[prop] === undefined) return;
          const field = target.kind === 'layer' ? 'layerEasings' : 'groupEasings';
          const maps = kf[field] ?? {};
          kf[field] = {
            ...maps,
            [target.id]: { ...maps[target.id], [prop]: easing },
          };
        }),

      addCueAtPlayhead: () => {
        const t0 = get().template;
        if (!t0) return;
        const director = t0.timeline.directors.find((item) => item.id === get().activeDirectorId)
          ?? t0.timeline.directors[0];
        if (!director) return;
        const directorId = director.id;
        const locals = playheadStore.getState().localPlayheads;
        const playhead = Math.min(
          director.durationFrames,
          Math.max(0, Math.round(locals[directorId] ?? currentPlayhead())),
        );
        const existing = findCueAtEffectiveFrame(
          t0.timeline.cues,
          directorId,
          playhead,
          director.durationFrames,
        );
        if (existing) {
          get().patch((t) => {
            const cue = (t.timeline.cues ?? []).find((item) => item.id === existing.id);
            if (!cue) return;
            cue.items = mergeCueItems(cue, [createCueItem('', directorId)]).items;
          });
          set({ selectedCueId: existing.id, selectedKeyframes: [], activeDirectorId: directorId });
          return;
        }
        const cue = createCue(directorId, playhead, false);
        get().patch((t) => {
          t.timeline.cues = [...(t.timeline.cues ?? []), cue];
        });
        set({ selectedCueId: cue.id, selectedKeyframes: [], activeDirectorId: directorId });
      },

      removeSelectedCue: () => {
        const cueId = get().selectedCueId;
        if (!cueId) return;
        get().patch((t) => {
          t.timeline.cues = (t.timeline.cues ?? []).filter((cue) => cue.id !== cueId);
        });
        set({ selectedCueId: null });
      },

      moveCue: (cueId, effectiveFrame) => {
        const t0 = get().template;
        const cue = t0?.timeline.cues?.find((item) => item.id === cueId);
        const director = t0?.timeline.directors.find((item) => item.id === cue?.directorId);
        if (!t0 || !cue || !director) return;
        const host = findCueAtEffectiveFrame(
          t0.timeline.cues,
          cue.directorId,
          effectiveFrame,
          director.durationFrames,
          cueId,
        );
        get().patch((t) => {
          const source = (t.timeline.cues ?? []).find((item) => item.id === cueId);
          if (!source) return;
          if (host) {
            const dest = (t.timeline.cues ?? []).find((item) => item.id === host.id);
            if (!dest) return;
            dest.items = mergeCueItems(dest, source.items).items;
            t.timeline.cues = (t.timeline.cues ?? []).filter((item) => item.id !== cueId);
            return;
          }
          source.frame = cueFrameFromEffective(effectiveFrame, source.fromEnd, director.durationFrames);
        });
        if (host) set({ selectedCueId: host.id });
      },

      updateCue: (cueId, partial) =>
        get().patch((t) => {
          const cue = (t.timeline.cues ?? []).find((item) => item.id === cueId);
          if (cue) Object.assign(cue, partial);
        }),

      addCueItem: (cueId, command = '') =>
        get().patch((t) => {
          const cue = (t.timeline.cues ?? []).find((item) => item.id === cueId);
          if (!cue) return;
          cue.items = mergeCueItems(cue, [createCueItem(command, cue.directorId)]).items;
        }),

      removeCueItem: (cueId, itemId) =>
        get().patch((t) => {
          const cue = (t.timeline.cues ?? []).find((item) => item.id === cueId);
          if (!cue || cue.items.length <= 1) return;
          const leftover = cue.items.filter((item) => item.id !== itemId);
          if (leftover.length === 0) return;
          cue.items = leftover as TimelineCue['items'];
        }),

      updateCueItem: (cueId, itemId, next) =>
        get().patch((t) => {
          const cue = (t.timeline.cues ?? []).find((item) => item.id === cueId);
          if (!cue) return;
          const host = t.timeline.directors.find((item) => item.id === cue.directorId) ?? { name: '' };
          cue.items = cue.items.map((item) => (
            item.id === itemId ? constrainCueTag(next, host, t.timeline.cues ?? [], cue.id) : item
          )) as TimelineCue['items'];
        }),

      addTrackAtPlayhead: (target, prop) => {
        const ph = currentPlayhead();
        const directorId = get().activeDirectorId;
        get().patch((t) => {
          if (tracksForDirector(t, directorId).some((track) => (
            track.target.kind === target.kind && track.target.id === target.id && track.prop === prop
          ))) return;
          const scope = keyframeScopeForWrite(t, target, prop, directorId);
          const kf = kfAt(t, ph, scope);
          const sec = target.kind === 'layer' ? kf.layers : kf.groups;
          (sec[target.id] ??= {})[prop] = baseValue(t, target, prop);
          if (!t.timeline.trackDirectors[target.id]) t.timeline.trackDirectors[target.id] = directorId;
          if (!scope) writePropertyDirector(t.timeline, target, prop, directorId);
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
