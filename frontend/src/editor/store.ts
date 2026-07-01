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
import { ANIMATABLE_PROPS, createDefaultTransform } from '@runtime';
import { createId } from '@/core/id';
import { createLayer, createVariable, LAYER_LABEL } from './factories';
import { captureGlobalPivots, entryKey, reparentEntriesIntoGroup, updateAncestorGroupBounds, updateGroupBounds } from './groupBounds';

export type Selection = { kind: 'layer' | 'group'; id: string } | null;
export type Target = { kind: 'layer' | 'group'; id: string };

function baseValue(t: Template, target: Target, prop: AnimatableProp): number {
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

/** Keep keyframes at the current playhead in sync when base props are edited. */
function syncAnimatedPropsAtPlayhead(
  t: Template,
  target: Target,
  values: Partial<Record<AnimatableProp, number>>,
  localFrame: number,
): void {
  const frame = Math.round(localFrame);
  for (const [prop, value] of Object.entries(values) as [AnimatableProp, number][]) {
    if (value === undefined || !hasAnimatedProp(t, target, prop)) continue;
    const kf = kfAt(t, frame);
    const sec = target.kind === 'layer' ? kf.layers : kf.groups;
    (sec[target.id] ??= {})[prop] = value;
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
  toggleVisible: (kind: 'layer' | 'group', id: string) => void;
  toggleLock: (kind: 'layer' | 'group', id: string) => void;
  setLayerGroup: (layerId: string, groupId: string | null) => void;
  addGroup: () => void;
  reorderContainer: (containerId: string | null, ids: string[]) => void;

  addVariable: () => void;
  updateVariable: (id: string, partial: Partial<Variable>) => void;
  removeVariable: (id: string) => void;

  // timeline + playback (playhead/playing/activeDirectorId are transient)
  playhead: number;
  playing: boolean;
  activeDirectorId: string;
  setPlayhead: (frame: number) => void;
  setPlaying: (playing: boolean) => void;
  setActiveDirector: (id: string) => void;
  setTimelineMeta: (partial: { fps?: number; durationFrames?: number; playbackMode?: 'bounded' | 'infinite' }) => void;
  addDirector: () => void;
  updateDirector: (id: string, partial: Partial<TimelineDirector>) => void;
  removeDirector: (id: string) => void;
  assignTrack: (targetId: string, directorId: string) => void;
  setKeyframeValue: (target: Target, frame: number, prop: AnimatableProp, value: number) => void;
  movePoint: (target: Target, prop: AnimatableProp, fromFrame: number, toFrame: number) => void;
  deletePoint: (target: Target, prop: AnimatableProp, frame: number) => void;
  removeTrack: (target: Target, prop: AnimatableProp) => void;
  setKeyframeEasing: (frame: number, easing: EasingType) => void;
  addTrackAtPlayhead: (target: Target, prop: AnimatableProp) => void;
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
      playhead: 0,
      playing: false,
      activeDirectorId: 'default',

      load: (t) => {
        const normalized = clone(t);
        for (const g of normalized.groups) {
          g.transform.width = 0;
          g.transform.height = 0;
        }
        set({
          template: normalized,
          selection: null,
          dirty: false,
          playhead: 0,
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
          if (l) mutator(l);
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
            get().playhead,
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
          syncAnimatedPropsAtPlayhead(
            t,
            { kind, id },
            animatableFromTransformPartial(partial),
            get().playhead,
          );
          if (kind === 'layer') {
            const layer = t.layers.find((x) => x.id === id);
            if (layer?.groupId) updateGroupBounds(t, layer.groupId);
          } else {
            updateAncestorGroupBounds(t, id);
          }
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
        get().patch((t) => {
          t.layers.push(copy);
          t.rootStack.push({ kind: 'layer', id: copy.id });
        });
        set({ selection: { kind: 'layer', id: copy.id } });
      },

      deleteSelected: () => {
        const sel = get().selection;
        if (!sel) return;
        get().patch((t) => {
          if (sel.kind === 'layer') {
            t.layers = t.layers.filter((l) => l.id !== sel.id);
          } else {
            // Re-parent the group's children to root, then drop the group.
            const children = t.groupStacks[sel.id] ?? [];
            for (const c of children) {
              if (c.kind === 'layer') {
                const l = t.layers.find((x) => x.id === c.id);
                if (l) l.groupId = null;
              }
              t.rootStack.push(c);
            }
            delete t.groupStacks[sel.id];
            t.groups = t.groups.filter((g) => g.id !== sel.id);
          }
          removeEntryEverywhere(t, sel.id);
          delete t.timeline.trackDirectors[sel.id];
          for (const kf of t.timeline.keyframes) {
            delete kf.layers[sel.id];
            delete kf.groups[sel.id];
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
          const prevGroupId = l.groupId;
          const entry = { kind: 'layer' as const, id: layerId };
          const globalPivots = captureGlobalPivots(t, [entry]);
          const targetWasEmpty = groupId
            ? (t.groupStacks[groupId] ?? []).filter((e) => e.id !== layerId).length === 0
            : false;
          removeEntryEverywhere(t, layerId);
          l.groupId = groupId;
          if (groupId) {
            addEntry(t, entry, groupId);
            reparentEntriesIntoGroup(t, groupId, [entry], targetWasEmpty, globalPivots);
          } else {
            const gp = globalPivots.get(entryKey(entry));
            if (gp) {
              l.transform.x = gp.x;
              l.transform.y = gp.y;
            }
          }
          if (prevGroupId) updateGroupBounds(t, prevGroupId);
        }),

      addGroup: () => {
        const t0 = get().template;
        if (!t0) return;
        const n = t0.groups.length + 1;
        const id = createId();
        get().patch((t) => {
          t.groups.push({
            id, name: `Group ${n}`, parentId: null, visible: true, locked: false,
            transform: { ...createDefaultTransform(0, 0), width: 0, height: 0 },
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
      setPlayhead: (frame) => set({ playhead: Math.max(0, Math.round(frame)) }),
      setPlaying: (playing) => set({ playing }),
      setActiveDirector: (id) => set({ activeDirectorId: id, playhead: 0, playing: false }),

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
        });
        set({ activeDirectorId: id, playhead: 0 });
      },

      updateDirector: (id, partial) =>
        get().patch((t) => {
          const d = t.timeline.directors.find((x) => x.id === id);
          if (d) Object.assign(d, partial);
        }),

      removeDirector: (id) => {
        const t0 = get().template;
        if (!t0 || t0.timeline.directors.length <= 1) return;
        get().patch((t) => {
          t.timeline.directors = t.timeline.directors.filter((d) => d.id !== id);
          for (const k of Object.keys(t.timeline.trackDirectors)) {
            if (t.timeline.trackDirectors[k] === id) delete t.timeline.trackDirectors[k];
          }
          t.timeline.actions = t.timeline.actions.filter((a) => a.directorId !== id);
        });
        if (get().activeDirectorId === id) {
          set({ activeDirectorId: get().template?.timeline.directors[0]?.id ?? 'default', playhead: 0 });
        }
      },

      assignTrack: (targetId, directorId) =>
        get().patch((t) => { t.timeline.trackDirectors[targetId] = directorId; }),

      setKeyframeValue: (target, frame, prop, value) =>
        get().patch((t) => {
          const kf = kfAt(t, Math.round(frame));
          const sec = target.kind === 'layer' ? kf.layers : kf.groups;
          (sec[target.id] ??= {})[prop] = value;
          if (!t.timeline.trackDirectors[target.id]) t.timeline.trackDirectors[target.id] = get().activeDirectorId;
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
          const stillAnimated = t.timeline.keyframes.some((k) => {
            const bag = (target.kind === 'layer' ? k.layers : k.groups)[target.id];
            return bag && Object.keys(bag).length > 0;
          });
          if (!stillAnimated) delete t.timeline.trackDirectors[target.id];
        }),

      setKeyframeEasing: (frame, easing) =>
        get().patch((t) => {
          const kf = t.timeline.keyframes.find((k) => k.frame === frame);
          if (kf) { kf.easing = easing; delete kf.bezier; }
        }),

      addTrackAtPlayhead: (target, prop) => {
        const ph = get().playhead;
        get().patch((t) => {
          const kf = kfAt(t, ph);
          const sec = target.kind === 'layer' ? kf.layers : kf.groups;
          (sec[target.id] ??= {})[prop] = baseValue(t, target, prop);
          if (!t.timeline.trackDirectors[target.id]) t.timeline.trackDirectors[target.id] = get().activeDirectorId;
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
