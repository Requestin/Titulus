import type { AnimatableValues, RectGradient, RectLayer } from './schema.js';

const NEUTRAL = { r: 128, g: 128, b: 128 };
const cssCache = new Map<string, string>();

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexByte(value: number): string {
  return value.toString(16).padStart(2, '0');
}

function rgbToHex(rgb: Rgb): string {
  return `#${hexByte(rgb.r)}${hexByte(rgb.g)}${hexByte(rgb.b)}`;
}

function parseHexColor(color: string): Rgb | null {
  const value = color.trim();
  const short = /^#([0-9a-fA-F]{3})$/.exec(value);
  if (short) {
    const [r, g, b] = short[1].split('');
    return {
      r: parseInt(r + r, 16),
      g: parseInt(g + g, 16),
      b: parseInt(b + b, 16),
    };
  }
  const full = /^#([0-9a-fA-F]{6})$/.exec(value);
  if (!full) return null;
  return {
    r: parseInt(full[1].slice(0, 2), 16),
    g: parseInt(full[1].slice(2, 4), 16),
    b: parseInt(full[1].slice(4, 6), 16),
  };
}

function clampWeight(weight: number): number {
  if (!Number.isFinite(weight)) return 0;
  return Math.min(100, Math.max(0, weight));
}

export function mixCornerTowardNeutral(color: string, weight: number): string {
  const rgb = parseHexColor(color);
  const t = clampWeight(weight) / 100;
  if (!rgb) return t === 0 ? '#808080' : color;
  if (t === 1) return rgbToHex(rgb);
  return rgbToHex({
    r: Math.round(rgb.r * t + NEUTRAL.r * (1 - t)),
    g: Math.round(rgb.g * t + NEUTRAL.g * (1 - t)),
    b: Math.round(rgb.b * t + NEUTRAL.b * (1 - t)),
  });
}

function normalizeHex(color: string): string {
  const rgb = parseHexColor(color);
  return rgb ? rgbToHex(rgb) : color.trim();
}

export function effectiveGradient(
  layer: Pick<RectLayer, 'fillMode' | 'gradient'>,
  anim?: AnimatableValues,
): RectGradient | null {
  if (layer.fillMode !== 'gradient' || !layer.gradient) return null;
  const weights = { ...layer.gradient.weights };
  if (anim) {
    if (anim['gradient.weights.topLeft'] !== undefined) weights.topLeft = anim['gradient.weights.topLeft']!;
    if (anim['gradient.weights.topRight'] !== undefined) weights.topRight = anim['gradient.weights.topRight']!;
    if (anim['gradient.weights.bottomLeft'] !== undefined) weights.bottomLeft = anim['gradient.weights.bottomLeft']!;
    if (anim['gradient.weights.bottomRight'] !== undefined) weights.bottomRight = anim['gradient.weights.bottomRight']!;
  }
  return {
    topLeft: layer.gradient.topLeft,
    topRight: layer.gradient.topRight,
    bottomLeft: layer.gradient.bottomLeft,
    bottomRight: layer.gradient.bottomRight,
    weights,
  };
}

export function gradientCacheKey(gradient: RectGradient): string {
  return [
    normalizeHex(gradient.topLeft),
    normalizeHex(gradient.topRight),
    normalizeHex(gradient.bottomLeft),
    normalizeHex(gradient.bottomRight),
    clampWeight(gradient.weights.topLeft),
    clampWeight(gradient.weights.topRight),
    clampWeight(gradient.weights.bottomLeft),
    clampWeight(gradient.weights.bottomRight),
  ].join('|');
}

function buildGradientCss(gradient: RectGradient): string {
  const topLeft = mixCornerTowardNeutral(gradient.topLeft, gradient.weights.topLeft);
  const topRight = mixCornerTowardNeutral(gradient.topRight, gradient.weights.topRight);
  const bottomLeft = mixCornerTowardNeutral(gradient.bottomLeft, gradient.weights.bottomLeft);
  const bottomRight = mixCornerTowardNeutral(gradient.bottomRight, gradient.weights.bottomRight);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2" preserveAspectRatio="none"><rect width="1" height="1" fill="${topLeft}"/><rect x="1" width="1" height="1" fill="${topRight}"/><rect y="1" width="1" height="1" fill="${bottomLeft}"/><rect x="1" y="1" width="1" height="1" fill="${bottomRight}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 0 0 / 100% 100% no-repeat`;
}

export function gradientBackgroundCss(gradient: RectGradient): string {
  const key = gradientCacheKey(gradient);
  const cached = cssCache.get(key);
  if (cached) return cached;
  const css = buildGradientCss(gradient);
  cssCache.set(key, css);
  return css;
}

export function gradientCssCacheSize(): number {
  return cssCache.size;
}

export function resetGradientCssCache(): void {
  cssCache.clear();
}
