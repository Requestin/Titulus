// runtime/src/transform.ts
//
// Anchor-aware transform math + CSS transform-string builder
// (DEVELOPMENT_PROMPT §6.2 layer transforms).
//
// A layer is laid out as:
//   - top-left at (x, y) in canvas px
//   - sized width × height
//   - rotated/scaled around an anchor that is a 0..1 pivot inside the box
//   - optional 3D rotation (rotationX/Y) when perspective > 0
//
// We position the element with left/top (so the box origin is the top-left) and
// apply rotation/scale via a transform-origin set to the anchor, which keeps the
// CSS transform matrix simple and matches what the editor selection box shows.

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
): AppliedTransform {
  const t: Transform = anim ? { ...base, ...anim } : base;

  // The element box is laid out at the unscaled width/height; scale is applied
  // via the CSS transform below (so transform-origin uses unscaled dims).
  // Anchor pivot in px inside the *unscaled* box; transform-origin is specified
  // relative to the element's border box, so we use the unscaled dims.
  const originX = t.width * t.anchorX;
  const originY = t.height * t.anchorY;

  const parts: string[] = [];
  if (t.perspective > 0 && (t.rotationX !== 0 || t.rotationY !== 0)) {
    parts.push(`perspective(${t.perspective}px)`);
  }
  if (t.rotationX !== 0) parts.push(`rotateX(${t.rotationX}deg)`);
  if (t.rotationY !== 0) parts.push(`rotateY(${t.rotationY}deg)`);
  if (t.rotation !== 0) parts.push(`rotate(${t.rotation}deg)`);
  if (t.scaleX !== 1 || t.scaleY !== 1) {
    parts.push(`scale(${t.scaleX}, ${t.scaleY})`);
  }

  return {
    left: t.x,
    top: t.y,
    width: t.width,
    height: t.height,
    originX,
    originY,
    transform: parts.length ? parts.join(' ') : 'none',
  };
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
