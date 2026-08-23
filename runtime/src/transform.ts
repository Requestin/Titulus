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
  /**
   * Phase 16 Class A: when true, `transform` already encodes the element's
   * position (translate3d) and the pivot (translate pair around rotate/scale),
   * so the DOM element must use `left:0; top:0; transform-origin:0 0`. This
   * moves x/y/rotation/scale animation off the Layout-triggering `left/top`
   * style writes and onto the compositor-friendly `transform` write.
   *
   * `left`/`top`/`width`/`height` keep their original numeric meaning regardless
   * (they are consumed by the editor overlay in CanvasArea.tsx and by the mask
   * geometry projector in maskGeometry.ts, which need the absolute box
   * coordinates, not whatever happens to be written to the DOM).
   */
  useCompositedPosition: boolean;
}

/**
 * Apply a base transform plus optional animated overrides, returning the
 * concrete geometry + CSS for the DOM element. Animated values (from timeline
 * keyframes) take precedence over the base transform when present.
 *
 * `opts.compositePosition` (Phase 16 Class A, default false): when true, pack
 * the element's x/y position into the CSS `transform` (translate3d) along with
 * an explicit pivot decomposition (translate pair around rotate/scale) so the
 * DOM element can be placed at `left:0; top:0; transform-origin:0 0` — moving
 * position/rotation off the Layout-triggering `left/top` style writes onto the
 * compositor-friendly `transform` write. When false (editor preview, mask
 * geometry), the legacy split is produced: `left/top` carry the position and
 * `transform` carries only rotate/scale with `transform-origin` set in px.
 */
export function applyTransform(
  base: Transform,
  anim: Partial<Transform> | undefined,
  opts?: { skipPerspective?: boolean; compositePosition?: boolean },
): AppliedTransform {
  const t: Transform = anim ? { ...base, ...anim } : base;

  // The element box is laid out at the unscaled width/height; scale is applied
  // via the CSS transform below (so transform-origin uses unscaled dims).
  // Anchor pivot in px inside the *unscaled* box; transform-origin is specified
  // relative to the element's border box, so we use the unscaled dims.
  const originX = t.width * t.anchorX;
  const originY = t.height * t.anchorY;

  const useComposited = opts?.compositePosition ?? false;
  const depth = t.z ?? 0;
  const usePerspective = !opts?.skipPerspective && t.perspective > 0
    && (t.rotationX !== 0 || t.rotationY !== 0 || (useComposited && depth !== 0));

  // Build the transform function list. Two equivalent encodings of the same
  // logical transformation (rotate/scale around the anchor pivot):
  //
  //   legacy:    transform = [perspective] [rotateX/Y] [rotate] [scale]
  //              applied with CSS transform-origin = originX originY
  //              (CSS wraps the whole list as T(o)·F·T(-o))
  //
  //   composite: transform = [perspective] translate3d(left,top,z|0)
  //                          translate(o) [rotateX/Y] [rotate] [scale]
  //                          translate(-o)
  //              applied with CSS transform-origin = 0 0
  //
  // The composite form folds the position into the transform so `left`/`top`
  // style writes can be skipped (left:0, top:0 constants) — this is the whole
  // point of Class A: x/y/rotation animations stop triggering Layout.
  const parts: string[] = [];
  if (usePerspective) {
    parts.push(`perspective(${t.perspective}px)`);
  }
  if (useComposited) {
    // Position (translate3d) goes BEFORE the pivot wrap so it is not itself
    // rotated/scaled — it is a pure world-space offset of the element box.
    const depthCss = depth === 0 ? '0' : `${depth.toFixed(2)}px`;
    parts.push(`translate3d(${(t.x - originX).toFixed(2)}px, ${(t.y - originY).toFixed(2)}px, ${depthCss})`);
    // Open the pivot wrap: shift origin to the anchor point inside the box.
    parts.push(`translate(${originX.toFixed(2)}px, ${originY.toFixed(2)}px)`);
  }
  if (t.rotationX !== 0) parts.push(`rotateX(${t.rotationX}deg)`);
  if (t.rotationY !== 0) parts.push(`rotateY(${t.rotationY}deg)`);
  if (t.rotation !== 0) parts.push(`rotate(${t.rotation}deg)`);
  if (t.scaleX !== 1 || t.scaleY !== 1) {
    parts.push(`scale(${t.scaleX}, ${t.scaleY})`);
  }
  if (useComposited) {
    // Close the pivot wrap: undo the origin shift so the rotation/scale pivot
    // is the anchor, not the box top-left.
    parts.push(`translate(${(-originX).toFixed(2)}px, ${(-originY).toFixed(2)}px)`);
  }

  return {
    left: t.x - originX,
    top: t.y - originY,
    width: t.width,
    height: t.height,
    originX,
    originY,
    transform: parts.length ? parts.join(' ') : 'none',
    useCompositedPosition: useComposited,
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

/** True when the transform uses 2.5D (tilt or explicit perspective). */
export function transformHas3D(t: Transform): boolean {
  return t.rotationX !== 0 || t.rotationY !== 0 || t.perspective > 0 || (t.z ?? 0) !== 0;
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
