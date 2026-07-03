import {
  anchorCompensatedUpdate,
  applyTransform,
  computeGroupBbox,
  computeGroupUnion,
  mapPointThroughGroupTransform,
  type GroupBbox,
  type RootStackEntry,
  type Template,
  type Transform,
} from '@runtime';
import { mapLayerPointToCanvas } from './pivot';
import { pivotCanvasPoint } from './pivot';

export type { GroupBbox };
export { computeGroupBbox, computeGroupUnion };

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

/** Groups keep width/height at 0; bbox is derived from children at render time. */
export function updateGroupBounds(t: Template, groupId: string): void {
  const g = t.groups.find((x) => x.id === groupId);
  if (!g) return;
  g.transform.width = 0;
  g.transform.height = 0;
}

/** Canvas-space AABB of a layer (maps through ancestor group transforms). */
export function layerCanvasAabb(
  template: Template,
  layerId: string,
  layerTransform: Transform,
  resolveGroupTransform?: (groupId: string) => Transform | undefined,
): { left: number; top: number; width: number; height: number } {
  const at = applyTransform(layerTransform, undefined);
  const corners = [
    mapLayerPointToCanvas(template, layerId, at.left, at.top, resolveGroupTransform),
    mapLayerPointToCanvas(template, layerId, at.left + at.width, at.top, resolveGroupTransform),
    mapLayerPointToCanvas(template, layerId, at.left + at.width, at.top + at.height, resolveGroupTransform),
    mapLayerPointToCanvas(template, layerId, at.left, at.top + at.height, resolveGroupTransform),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
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
  ({ x, y } = mapPointThroughGroupTransform(gt, computeGroupBbox(template, groupId), x, y));
  let parentId = g.parentId;
  while (parentId) {
    const pg = template.groups.find((gr) => gr.id === parentId);
    if (!pg) break;
    const pgt = pg.transform;
    ({ x, y } = mapPointThroughGroupTransform(pgt, computeGroupBbox(template, parentId), x, y));
    parentId = pg.parentId;
  }
  return { x, y };
}

/**
 * After stack/parent assignment: keep entry x/y unchanged so the child inherits
 * the group's position/rotation/scale globally instead of compensating coords.
 */
export function reparentEntriesIntoGroup(
  t: Template,
  groupId: string,
  moving: RootStackEntry[],
): void {
  if (moving.length === 0) return;
  updateGroupBounds(t, groupId);
}

/** @deprecated use reparentEntriesIntoGroup */
export function finalizeGroupReparent(
  t: Template,
  targetContainerId: string | null,
  moving: RootStackEntry[],
  _targetWasEmpty: boolean,
  _globalPivots?: Map<EntryKey, { x: number; y: number }>,
): void {
  if (!targetContainerId) return;
  reparentEntriesIntoGroup(t, targetContainerId, moving);
}

export function groupUnionSize(t: Template, groupId: string): { width: number; height: number } {
  const bbox = computeGroupBbox(t, groupId);
  if (!bbox) return { width: 0, height: 0 };
  return { width: bbox.width, height: bbox.height };
}

/** Pivot of a group in its parent space, derived from children bbox + anchor ratios. */
export function groupPivotParentPoint(g: Transform, bbox: GroupBbox): { x: number; y: number } {
  const localX = bbox.minL + bbox.width * g.anchorX;
  const localY = bbox.minT + bbox.height * g.anchorY;
  return mapPointThroughGroupTransform(g, bbox, localX, localY);
}

/** Pivot of a group mapped to canvas space. */
export function groupPivotCanvasPoint(
  template: Template,
  groupId: string,
  g: Transform,
  resolveGroupTransform?: (groupId: string) => Transform | undefined,
): { x: number; y: number } {
  const bbox = computeGroupBbox(template, groupId);
  if (!bbox) return walkGroupAncestors(template, groupId, g.x, g.y, resolveGroupTransform);
  const parentPivot = groupPivotParentPoint(g, bbox);
  return walkGroupAncestors(template, groupId, parentPivot.x, parentPivot.y, resolveGroupTransform);
}

function walkGroupAncestors(
  template: Template,
  groupId: string,
  x: number,
  y: number,
  resolveGroupTransform?: (groupId: string) => Transform | undefined,
): { x: number; y: number } {
  let parentId = template.groups.find((gr) => gr.id === groupId)?.parentId ?? null;
  while (parentId) {
    const pg = template.groups.find((gr) => gr.id === parentId);
    if (!pg) break;
    const gt = resolveGroupTransform?.(parentId) ?? pg.transform;
    ({ x, y } = mapPointThroughGroupTransform(gt, computeGroupBbox(template, parentId), x, y));
    parentId = pg.parentId;
  }
  return { x, y };
}

/**
 * Change group axis center on the children bbox.
 * Unlike layers, group x/y is the container origin; child positions are stored
 * in group-local space and do not depend on anchor ratios. Updating anchor alone
 * moves the visual pivot on the bbox while children keep global canvas positions.
 */
function compensateGroupAnchor(
  _g: Transform,
  _bbox: GroupBbox,
  axis: 'x' | 'y',
  newRatio: number,
): Partial<Transform> {
  return axis === 'x' ? { anchorX: newRatio } : { anchorY: newRatio };
}

export function axisCenterFromPixelsGroup(
  g: Transform,
  bbox: GroupBbox,
  axis: 'x' | 'y',
  px: number,
): Partial<Transform> {
  const size = axis === 'x' ? bbox.width : bbox.height;
  if (size <= 0) return {};
  return compensateGroupAnchor(g, bbox, axis, px / size);
}

export function axisCenterPresetXGroup(
  g: Transform,
  bbox: GroupBbox,
  preset: 'L' | 'C' | 'R',
): Partial<Transform> {
  const anchorX = preset === 'L' ? 0 : preset === 'C' ? 0.5 : 1;
  return compensateGroupAnchor(g, bbox, 'x', anchorX);
}

export function axisCenterPresetYGroup(
  g: Transform,
  bbox: GroupBbox,
  preset: 'T' | 'C' | 'B',
): Partial<Transform> {
  const anchorY = preset === 'T' ? 0 : preset === 'C' ? 0.5 : 1;
  return compensateGroupAnchor(g, bbox, 'y', anchorY);
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
