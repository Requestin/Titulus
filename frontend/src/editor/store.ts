// frontend/src/editor/store.ts
//
// Editor state: the editable Template, selection, zoom/grid, and undoable
// mutations (Zustand + zundo). Only `template` is tracked for undo/redo
// (selection/zoom are transient). Every mutation replaces `template` with a new
// object (structuredClone) so zundo records discrete history steps.

import { create, useStore } from 'zustand';
import { temporal } from 'zundo';
import type { Template, Layer, LayerType, Variable, Transform, RootStackEntry } from '@runtime';
import { createDefaultTransform } from '@runtime';
import { createLayer, createVariable, LAYER_LABEL } from './factories';

export type Selection = { kind: 'layer' | 'group'; id: string } | null;

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
      gridSnap: true,
      gridSize: 8,

      load: (t) => {
        set({ template: t, selection: null, dirty: false });
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

      updateTransform: (id, partial, kind = 'layer') =>
        get().patch((t) => {
          const target =
            kind === 'layer' ? t.layers.find((x) => x.id === id) : t.groups.find((x) => x.id === id);
          if (target) Object.assign(target.transform, partial);
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
        copy.id = crypto.randomUUID();
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
          l.groupId = groupId;
          removeEntryEverywhere(t, layerId);
          addEntry(t, { kind: 'layer', id: layerId }, groupId);
        }),

      addGroup: () => {
        const t0 = get().template;
        if (!t0) return;
        const n = t0.groups.length + 1;
        const id = crypto.randomUUID();
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
