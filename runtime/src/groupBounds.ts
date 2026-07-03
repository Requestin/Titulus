// runtime/src/groupBounds.ts
//
// Groups store width/height = 0; axis center and transform-origin are derived
// from the children union bbox + anchor ratios.

import { applyTransform, type AppliedTransform } from './transform.js';
import type { Template, Transform, RootStackEntry } from './schema.js';

export interface GroupBbox {
  minL: number;
  minT: number;
  width: number;
  height: number;
}

function entryTransform(t: Template, kind: RootStackEntry['kind'], id: string): Transform | null {
  if (kind === 'layer') {
    return t.layers.find((l) => l.id === id)?.transform ?? null;
  }
  return t.groups.find((g) => g.id === id)?.transform ?? null;
}

/** Union of direct child AABBs in group-local space. */
export function computeGroupUnion(
  t: Template,
  groupId: string,
): { minL: number; minT: number; maxR: number; maxB: number } | null {
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

export function computeGroupBbox(t: Template, groupId: string): GroupBbox | null {
  const union = computeGroupUnion(t, groupId);
  if (!union) return null;
  return {
    minL: union.minL,
    minT: union.minT,
    width: Math.max(1, union.maxR - union.minL),
    height: Math.max(1, union.maxB - union.minT),
  };
}

export function groupOriginFromBbox(
  bbox: GroupBbox | null,
  anchorX: number,
  anchorY: number,
): { originX: number; originY: number } {
  if (!bbox) return { originX: 0, originY: 0 };
  return {
    originX: bbox.minL + bbox.width * anchorX,
    originY: bbox.minT + bbox.height * anchorY,
  };
}

/** Map a point in group-local space through the group transform (bbox-based origin). */
export function mapPointThroughGroupTransform(
  parent: Transform,
  bbox: GroupBbox | null,
  localX: number,
  localY: number,
): { x: number; y: number } {
  const { originX: ox, originY: oy } = groupOriginFromBbox(bbox, parent.anchorX, parent.anchorY);
  const dx = localX - ox;
  const dy = localY - oy;
  const rad = (parent.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const sx = dx * parent.scaleX;
  const sy = dy * parent.scaleY;
  const rx = sx * cos - sy * sin;
  const ry = sx * sin + sy * cos;
  return { x: parent.x + ox + rx, y: parent.y + oy + ry };
}

/** Apply group transform with bbox-derived transform-origin for rotation/scale. */
export function applyGroupTransform(
  base: Transform,
  bbox: GroupBbox | null,
  anim?: Partial<Transform>,
  opts?: { skipPerspective?: boolean },
): AppliedTransform {
  const at = applyTransform(base, anim, opts);
  const t = anim ? { ...base, ...anim } : base;
  const { originX, originY } = groupOriginFromBbox(bbox, t.anchorX, t.anchorY);
  return {
    ...at,
    left: t.x,
    top: t.y,
    originX,
    originY,
  };
}
