// runtime/src/maskGeometry.ts
//
// Projected mask polygons for rotated / 2.5D masks (Phase 9.6).
// Axis-aligned fast paths stay in maskScopes.ts; this module handles
// clip-path polygons when the mask transform is non-axis-aligned.

import type { Transform } from './schema.js';
import type { AppliedTransform } from './transform.js';

const DEG = Math.PI / 180;
const QUANT_PX = 0.5;

export interface Point2D {
  x: number;
  y: number;
}

function quantize(n: number): number {
  return Math.round(n / QUANT_PX) * QUANT_PX;
}

/** True when axis-aligned overflow clip is insufficient (any rotation/tilt). */
export function maskNeedsProjection(t: Transform): boolean {
  return t.rotation !== 0 || t.rotationX !== 0 || t.rotationY !== 0;
}

/**
 * Project the four corners of a mask rect into container-local 2D coordinates.
 * `at` must already be in the coordinate system of the clip container.
 */
export function projectMaskQuad(t: Transform, at: AppliedTransform): Point2D[] {
  const w = at.width;
  const h = at.height;
  const corners: [number, number][] = [[0, 0], [w, 0], [w, h], [0, h]];
  return corners.map(([lx, ly]) => transformCorner(lx, ly, at, t));
}

function transformCorner(
  lx: number,
  ly: number,
  at: AppliedTransform,
  t: Transform,
): Point2D {
  const ox = at.originX;
  const oy = at.originY;
  let x = lx - ox;
  let y = ly - oy;
  let z = 0;

  if (t.rotationX !== 0) {
    const r = t.rotationX * DEG;
    const c = Math.cos(r);
    const s = Math.sin(r);
    const ny = y * c - z * s;
    const nz = y * s + z * c;
    y = ny;
    z = nz;
  }
  if (t.rotationY !== 0) {
    const r = t.rotationY * DEG;
    const c = Math.cos(r);
    const s = Math.sin(r);
    const nx = x * c + z * s;
    const nz = -x * s + z * c;
    x = nx;
    z = nz;
  }
  if (t.rotation !== 0) {
    const r = t.rotation * DEG;
    const c = Math.cos(r);
    const s = Math.sin(r);
    const nx = x * c - y * s;
    const ny = x * s + y * c;
    x = nx;
    y = ny;
  }

  x *= t.scaleX;
  y *= t.scaleY;

  const persp = t.perspective > 0 ? t.perspective : 1000;
  if (t.rotationX !== 0 || t.rotationY !== 0) {
    const scale = persp / (persp - z);
    x *= scale;
    y *= scale;
  }

  return {
    x: quantize(at.left + ox + x),
    y: quantize(at.top + oy + y),
  };
}

/** Stable cache key for a projected quad (quantized). */
export function maskGeometryKey(quad: Point2D[]): string {
  return quad.map((p) => `${p.x},${p.y}`).join(' ');
}

/**
 * Build clip-path for a projected mask quad. Coordinates are container-local.
 */
export function projectedMaskClip(
  mask: { maskMode: 'normal' | 'inverted' },
  quad: Point2D[],
  containerW: number,
  containerH: number,
): { clipPath: string; overflow: string } {
  const inner = quad.map((p) => `${p.x}px ${p.y}px`).join(', ');
  if (mask.maskMode === 'normal') {
    return {
      overflow: 'hidden',
      clipPath: `polygon(${inner})`,
    };
  }
  const outer = `0px 0px, ${containerW}px 0px, ${containerW}px ${containerH}px, 0px ${containerH}px`;
  return {
    overflow: 'hidden',
    clipPath: `polygon(evenodd, ${outer}, ${inner})`,
  };
}
