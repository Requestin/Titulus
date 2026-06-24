// runtime/src/easing.ts
//
// Easing functions for timeline keyframe interpolation (DEVELOPMENT_PROMPT §6.2).
// Pure math, no DOM. Each easing maps a normalized time t in [0,1] to an eased
// progress value in [0,1].
//
// Own implementation (not GSAP — DEVELOPMENT_PROMPT §6.1: no external animation
// libs). The set mirrors CasparCG template animation practice: linear for
// mechanical motion, power2 for natural ease, bounce/elastic for emphasis.

import type { EasingType, BezierHandle } from './schema.js';

export type EasingFn = (t: number) => number;

const linear: EasingFn = (t) => t;

const power2 = {
  in: (t: number) => t * t,
  out: (t: number) => t * (2 - t),
  inOut: (t: number) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
};

// bounce.out: a few diminishing parabolic bounces at the end.
const bounceOut: EasingFn = (t: number) => {
  if (t < 1 / 2.75) return 7.5625 * t * t;
  if (t < 2 / 2.75) {
    t -= 1.5 / 2.75;
    return 7.5625 * t * t + 0.75;
  }
  if (t < 2.5 / 2.75) {
    t -= 2.25 / 2.75;
    return 7.5625 * t * t + 0.9375;
  }
  t -= 2.625 / 2.75;
  return 7.5625 * t * t + 0.984375;
};

// elastic.out: decaying sine wave past the target then settle.
const elasticOut: EasingFn = (t: number) => {
  if (t === 0 || t === 1) return t;
  const p = 0.3;       // period
  const s = p / 4;     // phase offset for sin
  return Math.pow(2, -10 * t) * Math.sin(((t - s) * (2 * Math.PI)) / p) + 1;
};

const EASINGS: Record<Exclude<EasingType, 'linear'>, EasingFn> = {
  'power2.in': power2.in,
  'power2.out': power2.out,
  'power2.inOut': power2.inOut,
  'bounce.out': bounceOut,
  'elastic.out': elasticOut,
};

/** Resolve an EasingType to its function. Unknown types fall back to linear. */
export function getEasing(type: EasingType): EasingFn {
  if (type === 'linear') return linear;
  return EASINGS[type] ?? linear;
}

/**
 * Cubic-bezier easing matching CSS `cubic-bezier(cp1x, cp1y, cp2x, cp2y)`.
 * Solved by Newton-Raphson with a bisection fallback for robustness. Used when
 * a keyframe specifies a custom bezier handle.
 */
export function makeBezierEasing(b: BezierHandle): EasingFn {
  // CSS bezier control points: P0=(0,0), P1=(cp1), P2=(cp2), P3=(1,1).
  const cx = 3 * b.cp1x;
  const bx = 3 * (b.cp2x - b.cp1x) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * b.cp1y;
  const by = 3 * (b.cp2y - b.cp1y) - cy;
  const ay = 1 - cy - by;

  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDerivX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  return (x: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // Newton-Raphson to find parametric t for the given x.
    let t = x;
    for (let i = 0; i < 8; i++) {
      const dx = sampleX(t) - x;
      if (Math.abs(dx) < 1e-6) return sampleY(t);
      const d = sampleDerivX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= dx / d;
    }
    // Bisection fallback.
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 24; i++) {
      const xt = sampleX(t);
      if (Math.abs(xt - x) < 1e-6) return sampleY(t);
      if (x > xt) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

/** Interpolate two numbers; `eased` is the eased progress in [0,1]. */
export function lerp(a: number, b: number, eased: number): number {
  return a + (b - a) * eased;
}
