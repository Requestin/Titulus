import { applyTransform, type Template, type Transform } from '@runtime';
import type { Target } from './store';

/** Map a point in parent-local space through a transform into grandparent/canvas space. */
export function mapPointThroughTransform(parent: Transform, localX: number, localY: number): { x: number; y: number } {
  const at = applyTransform(parent, undefined);
  const ox = at.originX;
  const oy = at.originY;
  const dx = localX - ox;
  const dy = localY - oy;
  const rad = (parent.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const sx = dx * parent.scaleX;
  const sy = dy * parent.scaleY;
  const rx = sx * cos - sy * sin;
  const ry = sx * sin + sy * cos;
  return { x: at.left + ox + rx, y: at.top + oy + ry };
}

/** Inverse of mapPointThroughTransform — canvas/grandparent → parent-local pivot coords. */
export function inverseMapPointThroughTransform(parent: Transform, canvasX: number, canvasY: number): { x: number; y: number } {
  const at = applyTransform(parent, undefined);
  const ox = at.originX;
  const oy = at.originY;
  const scaleX = parent.scaleX || 1;
  const scaleY = parent.scaleY || 1;
  const rad = (-parent.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = canvasX - (at.left + ox);
  const dy = canvasY - (at.top + oy);
  const rx = dx * cos - dy * sin;
  const ry = dx * sin + dy * cos;
  return { x: ox + rx / scaleX, y: oy + ry / scaleY };
}

/** Canvas-space delta when a parent-local point moves by (dlx, dly). */
export function localDeltaToCanvas(parent: Transform, dlx: number, dly: number): { dx: number; dy: number } {
  const a = mapPointThroughTransform(parent, 0, 0);
  const b = mapPointThroughTransform(parent, dlx, dly);
  return { dx: b.x - a.x, dy: b.y - a.y };
}

/** Map a pivot (x,y) in local transform space up through ancestor groups to canvas space. */
export function pivotCanvasPoint(template: Template, target: Target, t: Transform): { x: number; y: number } {
  let x = t.x;
  let y = t.y;

  if (target.kind === 'layer') {
    const layer = template.layers.find((l) => l.id === target.id);
    let groupId = layer?.groupId ?? null;
    while (groupId) {
      const g = template.groups.find((gr) => gr.id === groupId);
      if (!g) break;
      ({ x, y } = mapPointThroughTransform(g.transform, x, y));
      groupId = g.parentId;
    }
  } else {
    let groupId = template.groups.find((g) => g.id === target.id)?.parentId ?? null;
    while (groupId) {
      const g = template.groups.find((gr) => gr.id === groupId);
      if (!g) break;
      ({ x, y } = mapPointThroughTransform(g.transform, x, y));
      groupId = g.parentId;
    }
  }

  return { x, y };
}

export function axisCrosshairSize(zoom: number): number {
  return Math.max(8, 12 * zoom);
}
