import { anchorCompensatedUpdate, applyTransform, type RootStackEntry, type Template, type Transform } from '@runtime';
import {
  inverseMapPointThroughTransform,
  localDeltaToCanvas,
  mapPointThroughTransform,
  pivotCanvasPoint,
} from './pivot';

export type EntryKey = `${RootStackEntry['kind']}:${string}`;

export function entryKey(entry: RootStackEntry): EntryKey {
  return `${entry.kind}:${entry.id}`;
}

function entryTransform(t: Template, kind: 'layer' | 'group', id: string): Transform | null {
  if (kind === 'layer') {
    return t.layers.find((l) => l.id === id)?.transform ?? null;
  }
  return t.groups.find((g) => g.id === id)?.transform ?? null;
}

function setEntryTransform(t: Template, kind: 'layer' | 'group', id: string, partial: Partial<Transform>): void {
  if (kind === 'layer') {
    const l = t.layers.find((x) => x.id === id);
    if (l) Object.assign(l.transform, partial);
    return;
  }
  const g = t.groups.find((x) => x.id === id);
  if (g) {
    Object.assign(g.transform, partial);
    g.transform.width = 0;
    g.transform.height = 0;
  }
}

function containerEntries(t: Template, containerId: string | null): RootStackEntry[] {
  return containerId === null ? t.rootStack : (t.groupStacks[containerId] ?? []);
}

/** Front-to-back display order (topmost / highest z-index first). */
export function collectDisplayEntries(t: Template, containerId: string | null = null, out: RootStackEntry[] = []): RootStackEntry[] {
  for (const entry of [...containerEntries(t, containerId)].reverse()) {
    out.push(entry);
    if (entry.kind === 'group') collectDisplayEntries(t, entry.id, out);
  }
  return out;
}

/** Among moving entries, pick the one highest in the layer tree (frontmost). */
export function topmostMovingEntry(t: Template, moving: RootStackEntry[]): RootStackEntry {
  const movingKeys = new Set(moving.map(entryKey));
  for (const entry of collectDisplayEntries(t)) {
    if (movingKeys.has(entryKey(entry))) return entry;
  }
  return moving[0]!;
}

/** Capture canvas pivot for each entry while it still lives in its old parent. */
export function captureGlobalPivots(t: Template, entries: RootStackEntry[]): Map<EntryKey, { x: number; y: number }> {
  const out = new Map<EntryKey, { x: number; y: number }>();
  for (const entry of entries) {
    const tr = entryTransform(t, entry.kind, entry.id);
    if (!tr) continue;
    out.set(entryKey(entry), pivotCanvasPoint(t, entry, tr));
  }
  return out;
}

/** Union of direct child AABBs in group-local space (pivot-based transforms). */
export function computeGroupUnion(t: Template, groupId: string): { minL: number; minT: number; maxR: number; maxB: number } | null {
  const entries = t.groupStacks[groupId] ?? [];
  if (entries.length === 0) return null;

  let minL = Infinity;
  let minT = Infinity;
  let maxR = -Infinity;
  let maxB = -Infinity;

  for (const e of entries) {
    const tr = entryTransform(t, e.kind, e.id);
    if (!tr) continue;
    const at = applyTransform(tr, undefined);
    minL = Math.min(minL, at.left);
    minT = Math.min(minT, at.top);
    maxR = Math.max(maxR, at.left + at.width);
    maxB = Math.max(maxB, at.top + at.height);
  }

  if (!Number.isFinite(minL)) return null;
  return { minL, minT, maxR, maxB };
}

/** Resize group box to wrap direct children; normalize local origin without moving canvas positions. */
export function updateGroupBounds(t: Template, groupId: string): void {
  const g = t.groups.find((x) => x.id === groupId);
  if (!g) return;
  const union = computeGroupUnion(t, groupId);
  if (!union) return;

  const { minL, minT } = union;

  if (minL !== 0 || minT !== 0) {
    for (const e of t.groupStacks[groupId] ?? []) {
      const tr = entryTransform(t, e.kind, e.id);
      if (!tr) continue;
      setEntryTransform(t, e.kind, e.id, { x: tr.x - minL, y: tr.y - minT });
    }
    const delta = localDeltaToCanvas(g.transform, minL, minT);
    g.transform.x += delta.dx;
    g.transform.y += delta.dy;
  }

  g.transform.width = 0;
  g.transform.height = 0;
}

/** Canvas-space AABB of a group's children (group transform width/height are always 0). */
export function groupCanvasAabb(
  template: Template,
  groupId: string,
  groupTransform: Transform,
): { left: number; top: number; width: number; height: number } | null {
  const union = computeGroupUnion(template, groupId);
  const g = template.groups.find((x) => x.id === groupId);
  if (!union || !g) return null;

  const { minL, minT, maxR, maxB } = union;
  const corners = [
    localPointToCanvas(template, groupId, minL, minT, groupTransform),
    localPointToCanvas(template, groupId, maxR, minT, groupTransform),
    localPointToCanvas(template, groupId, maxR, maxB, groupTransform),
    localPointToCanvas(template, groupId, minL, maxB, groupTransform),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

/** Map a point in group-local space to canvas coordinates. */
export function localPointToCanvas(
  template: Template,
  groupId: string,
  localX: number,
  localY: number,
  groupTransform?: Transform,
): { x: number; y: number } {
  const g = template.groups.find((x) => x.id === groupId);
  if (!g) return { x: localX, y: localY };
  const gt = groupTransform ?? g.transform;
  let x = localX;
  let y = localY;
  ({ x, y } = mapPointThroughTransform(gt, x, y));
  let parentId = g.parentId;
  while (parentId) {
    const pg = template.groups.find((gr) => gr.id === parentId);
    if (!pg) break;
    ({ x, y } = mapPointThroughTransform(pg.transform, x, y));
    parentId = pg.parentId;
  }
  return { x, y };
}

function adoptGroupFromReference(
  t: Template,
  groupId: string,
  reference: RootStackEntry,
  globalPivot: { x: number; y: number },
): void {
  const g = t.groups.find((x) => x.id === groupId);
  const refTr = entryTransform(t, reference.kind, reference.id);
  if (!g || !refTr) return;
  g.transform.x = globalPivot.x;
  g.transform.y = globalPivot.y;
  g.transform.anchorX = refTr.anchorX;
  g.transform.anchorY = refTr.anchorY;
  g.transform.width = 0;
  g.transform.height = 0;
}

function convertEntryToGroupLocal(
  t: Template,
  groupId: string,
  entry: RootStackEntry,
  globalPivot: { x: number; y: number },
): void {
  const g = t.groups.find((x) => x.id === groupId);
  const tr = entryTransform(t, entry.kind, entry.id);
  if (!g || !tr) return;
  const local = inverseMapPointThroughTransform(g.transform, globalPivot.x, globalPivot.y);
  setEntryTransform(t, entry.kind, entry.id, { x: local.x, y: local.y });
}

/**
 * After stack/parent assignment: place group at reference pivot, convert moved
 * entries to group-local coords so canvas positions stay unchanged.
 */
export function reparentEntriesIntoGroup(
  t: Template,
  groupId: string,
  moving: RootStackEntry[],
  targetWasEmpty: boolean,
  globalPivots: Map<EntryKey, { x: number; y: number }>,
): void {
  if (moving.length === 0) return;

  const reference = topmostMovingEntry(t, moving);
  const refGlobal = globalPivots.get(entryKey(reference));
  if (targetWasEmpty && refGlobal) {
    adoptGroupFromReference(t, groupId, reference, refGlobal);
  }

  for (const entry of moving) {
    const gp = globalPivots.get(entryKey(entry));
    if (!gp) continue;
    convertEntryToGroupLocal(t, groupId, entry, gp);
  }

  updateGroupBounds(t, groupId);
}

/** @deprecated use reparentEntriesIntoGroup */
export function finalizeGroupReparent(
  t: Template,
  targetContainerId: string | null,
  moving: RootStackEntry[],
  targetWasEmpty: boolean,
  globalPivots?: Map<EntryKey, { x: number; y: number }>,
): void {
  if (!targetContainerId) return;
  const pivots = globalPivots ?? captureGlobalPivots(t, moving);
  reparentEntriesIntoGroup(t, targetContainerId, moving, targetWasEmpty, pivots);
}

/** Recompute bounds for every ancestor group of a layer/group id. */
export function updateAncestorGroupBounds(t: Template, entryId: string): void {
  for (const [groupId, stack] of Object.entries(t.groupStacks)) {
    if (stack.some((e) => e.id === entryId)) {
      updateGroupBounds(t, groupId);
      updateAncestorGroupBounds(t, groupId);
    }
  }
}

export function groupUnionSize(t: Template, groupId: string): { width: number; height: number } {
  const union = computeGroupUnion(t, groupId);
  if (!union) return { width: 0, height: 0 };
  return {
    width: Math.max(1, union.maxR - union.minL),
    height: Math.max(1, union.maxB - union.minT),
  };
}

function virtualGroupTransform(t: Transform, unionW: number, unionH: number): Transform {
  return { ...t, width: unionW, height: unionH };
}

export function axisCenterFromPixelsGroup(
  t: Transform,
  unionW: number,
  unionH: number,
  axis: 'x' | 'y',
  px: number,
): Partial<Transform> {
  const v = virtualGroupTransform(t, unionW, unionH);
  const result = axisCenterFromPixels(v, axis, px);
  return { x: result.x, y: result.y, anchorX: result.anchorX, anchorY: result.anchorY };
}

export function axisCenterPresetXGroup(
  t: Transform,
  unionW: number,
  unionH: number,
  preset: 'L' | 'C' | 'R',
): Partial<Transform> {
  const result = axisCenterPresetX(virtualGroupTransform(t, unionW, unionH), preset);
  return { x: result.x, y: result.y, anchorX: result.anchorX, anchorY: result.anchorY };
}

export function axisCenterPresetYGroup(
  t: Transform,
  unionW: number,
  unionH: number,
  preset: 'T' | 'C' | 'B',
): Partial<Transform> {
  const result = axisCenterPresetY(virtualGroupTransform(t, unionW, unionH), preset);
  return { x: result.x, y: result.y, anchorX: result.anchorX, anchorY: result.anchorY };
}

export function axisCenterPresetX(t: Transform, preset: 'L' | 'C' | 'R'): Partial<Transform> {
  const anchorX = preset === 'L' ? 0 : preset === 'C' ? 0.5 : 1;
  return anchorCompensatedUpdate(t, { anchorX });
}

export function axisCenterPresetY(t: Transform, preset: 'T' | 'C' | 'B'): Partial<Transform> {
  const anchorY = preset === 'T' ? 0 : preset === 'C' ? 0.5 : 1;
  return anchorCompensatedUpdate(t, { anchorY });
}

export function axisCenterFromPixels(t: Transform, axis: 'x' | 'y', px: number): Partial<Transform> {
  const size = axis === 'x' ? t.width : t.height;
  if (size <= 0) return {};
  const ratio = px / size;
  return axis === 'x'
    ? anchorCompensatedUpdate(t, { anchorX: ratio })
    : anchorCompensatedUpdate(t, { anchorY: ratio });
}
