// runtime/src/transform.ts
//
// Anchor-aware transform math + CSS transform-string builder
// (DEVELOPMENT_PROMPT §6.2 layer transforms).
//
// A layer's transform stores the **pivot (anchor) position** in parent space as
// `x`/`y`. The DOM top-left is derived: left = x - width*anchorX, etc.
// Rotation and scale apply around that pivot via transform-origin on the box.

import type { Transform } from './schema.js';

export interface AppliedTransform {
  left: number;
  top: number;
  width: number;
  height: number;
  /** transform-origin in px relative to the element box */
  originX: number;
  originY: number;
  /** CSS `transform` value (may be 'none') */
  transform: string;
}

/**
 * Apply a base transform plus optional animated overrides, returning the
 * concrete geometry + CSS for the DOM element. Animated values (from timeline
 * keyframes) take precedence over the base transform when present.
 */
export function applyTransform(
  base: Transform,
  anim: Partial<Transform> | undefined,
  opts?: { skipPerspective?: boolean },
): AppliedTransform {
  const t: Transform = anim ? { ...base, ...anim } : base;

  // The element box is laid out at the unscaled width/height; scale is applied
  // via the CSS transform below (so transform-origin uses unscaled dims).
  // Anchor pivot in px inside the *unscaled* box; transform-origin is specified
  // relative to the element's border box, so we use the unscaled dims.
  const originX = t.width * t.anchorX;
  const originY = t.height * t.anchorY;

  const parts: string[] = [];
  const usePerspective = !opts?.skipPerspective && t.perspective > 0
    && (t.rotationX !== 0 || t.rotationY !== 0);
  if (usePerspective) {
    parts.push(`perspective(${t.perspective}px)`);
  }
  if (t.rotationX !== 0) parts.push(`rotateX(${t.rotationX}deg)`);
  if (t.rotationY !== 0) parts.push(`rotateY(${t.rotationY}deg)`);
  if (t.rotation !== 0) parts.push(`rotate(${t.rotation}deg)`);
  if (t.scaleX !== 1 || t.scaleY !== 1) {
    parts.push(`scale(${t.scaleX}, ${t.scaleY})`);
  }

  return {
    left: t.x - originX,
    top: t.y - originY,
    width: t.width,
    height: t.height,
    originX,
    originY,
    transform: parts.length ? parts.join(' ') : 'none',
  };
}

/**
 * Adjust x/y when the user moves the anchor pivot so the unrotated visual
 * placement stays fixed. `x`/`y` are the pivot position in parent space.
 */
export function anchorCompensatedUpdate(
  t: Transform,
  next: Partial<Pick<Transform, 'anchorX' | 'anchorY'>>,
): Partial<Transform> {
  const newAx = next.anchorX ?? t.anchorX;
  const newAy = next.anchorY ?? t.anchorY;
  return {
    ...next,
    x: t.x + (newAx - t.anchorX) * t.width,
    y: t.y + (newAy - t.anchorY) * t.height,
  };
}

/**
 * True when the transform uses real 2.5D tilt (rotationX/Y).
 * Default `perspective: 1000` alone is NOT 3D — treating it as such forced
 * `preserve-3d` on every layer and broke CSS `scale()` under CEF CPU raster
 * (editor GPU path still looked fine; SDI/engine did not).
 */
export function transformHas3D(t: Transform): boolean {
  return t.rotationX !== 0 || t.rotationY !== 0;
}

/** CSS blend-mode string for a layer. */
export function blendModeCss(mode: string): string {
  // DOM supports the full CSS blend-mode list; our schema enum maps 1:1 except
  // 'add' which we treat as 'plus-lighter' (Chromium) or 'lighten' fallback.
  if (mode === 'add') return 'plus-lighter';
  return mode;
}

/**
 * Convert opacity 0..1 to a CSS opacity string (clamped).
 */
export function opacityCss(o: number | undefined): string {
  if (o === undefined || Number.isNaN(o)) return '1';
  return String(Math.max(0, Math.min(1, o)));
}
