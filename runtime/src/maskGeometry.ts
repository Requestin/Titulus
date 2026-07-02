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

export interface MaskShapeSpec {
  maskMode: 'normal' | 'inverted';
  shape: 'rect' | 'ellipse';
  cornerRadius: number;
}

const ARC_SEGMENTS = 8;
const ELLIPSE_SEGMENTS = 32;

function sampleRoundedRectOutline(w: number, h: number, radius: number): [number, number][] {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  if (r <= 0.001) {
    return [[0, 0], [w, 0], [w, h], [0, h]];
  }
  const pts: [number, number][] = [];
  const pushArc = (cx: number, cy: number, a0: number, a1: number) => {
    for (let i = 0; i < ARC_SEGMENTS; i++) {
      const a = a0 + ((a1 - a0) * i) / ARC_SEGMENTS;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  pushArc(w - r, r, -Math.PI / 2, 0);
  pushArc(w - r, h - r, 0, Math.PI / 2);
  pushArc(r, h - r, Math.PI / 2, Math.PI);
  pushArc(r, r, Math.PI, (3 * Math.PI) / 2);
  return pts;
}

function sampleEllipseOutline(w: number, h: number): [number, number][] {
  const rx = w / 2;
  const ry = h / 2;
  const cx = rx;
  const cy = ry;
  const pts: [number, number][] = [];
  for (let i = 0; i < ELLIPSE_SEGMENTS; i++) {
    const a = (2 * Math.PI * i) / ELLIPSE_SEGMENTS;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
}

/**
 * Project mask perimeter into container-local 2D coordinates.
 * Supports rounded rects and ellipses under rotation / 2.5D tilt.
 */
export function projectMaskOutline(
  mask: MaskShapeSpec,
  t: Transform,
  at: AppliedTransform,
): Point2D[] {
  const local = mask.shape === 'ellipse'
    ? sampleEllipseOutline(at.width, at.height)
    : sampleRoundedRectOutline(at.width, at.height, mask.cornerRadius);
  return local.map(([lx, ly]) => transformCorner(lx, ly, at, t));
}

/**
 * Project the four corners of a mask rect into container-local 2D coordinates.
 * @deprecated Prefer projectMaskOutline — preserves corner radius under projection.
 */
export function projectMaskQuad(t: Transform, at: AppliedTransform): Point2D[] {
  return projectMaskOutline({ maskMode: 'normal', shape: 'rect', cornerRadius: 0 }, t, at);
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
    const denom = persp - z;
    // Near-singular perspective (rotationY ~ 90°): scale blows up and the
    // projected polygon collapses to a sliver — clip-path clips the whole
    // group to black for a frame (Phase 10.6 Group 3 flash).
    if (Math.abs(denom) < 1) {
      return { x: Number.NaN, y: Number.NaN };
    }
    const scale = persp / denom;
    if (!Number.isFinite(scale) || scale > 64) {
      return { x: Number.NaN, y: Number.NaN };
    }
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

/** Signed polygon area (px²). Shoelace; 0 when collinear/collapsed. */
export function outlineSignedArea(outline: Point2D[]): number {
  const n = outline.length;
  if (n < 3) return 0;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += outline[i].x * outline[j].y - outline[j].x * outline[i].y;
  }
  return a * 0.5;
}

/**
 * True when a projected mask outline should not be applied — applying a
 * collapsed/invalid polygon clips the entire masked subtree to nothing.
 */
export function isDegenerateProjectedOutline(
  outline: Point2D[],
  containerW: number,
  containerH: number,
  minAreaPx2 = 16,
): boolean {
  if (outline.length < 3) return true;
  for (const p of outline) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return true;
  }
  const area = Math.abs(outlineSignedArea(outline));
  if (!Number.isFinite(area) || area < minAreaPx2) return true;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of outline) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const bw = maxX - minX;
  const bh = maxY - minY;
  if (bw < 0.5 && bh < 0.5) return true;

  // Projected corners wildly outside the container indicate a singular tilt.
  const margin = Math.max(containerW, containerH) * 2;
  if (minX < -margin || maxX > containerW + margin ||
      minY < -margin || maxY > containerH + margin) {
    return true;
  }
  return false;
}

/**
 * Build clip-path for a projected mask quad. Coordinates are container-local.
 */
export function projectedMaskClip(
  mask: MaskShapeSpec,
  outline: Point2D[],
  containerW: number,
  containerH: number,
): { clipPath: string; overflow: string } {
  const inner = outline.map((p) => `${p.x}px ${p.y}px`).join(', ');
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
