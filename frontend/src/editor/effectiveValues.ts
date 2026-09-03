import {
  normalizeTimeline,
  sampleAt,
  ANIMATABLE_PROPS,
  type AnimatableProp,
  type Template,
  type Transform,
} from '@runtime';
import type { Target } from './store';

export function globalFrame(template: Template, directorId: string, localPlayhead: number): number {
  const d = template.timeline.directors.find((x) => x.id === directorId);
  return (d?.offsetFrames ?? 0) + localPlayhead;
}

export function effectiveAnimatableValues(
  template: Template,
  target: Target,
  localPlayhead: number,
  directorId: string,
): Partial<Record<AnimatableProp, number>> {
  const norm = normalizeTimeline(template.timeline);
  const sample = sampleAt(norm, globalFrame(template, directorId, localPlayhead));
  return (target.kind === 'layer' ? sample.layers[target.id] : sample.groups[target.id]) ?? {};
}

/** Transform + opacity values as shown on canvas at the current playhead. */
export function effectiveTransform(
  template: Template,
  base: Transform,
  target: Target,
  localPlayhead: number,
  directorId: string,
): Transform {
  const anim = effectiveAnimatableValues(template, target, localPlayhead, directorId);
  const out = { ...base };
  for (const p of ANIMATABLE_PROPS) {
    if (p === 'opacity') continue;
    if (anim[p] !== undefined) (out as unknown as Record<string, number>)[p] = anim[p]!;
  }
  const animatedZ = (anim as { z?: number }).z;
  if (animatedZ !== undefined) out.z = animatedZ;
  return out;
}

export function effectiveOpacity(
  template: Template,
  base: number,
  target: Target,
  localPlayhead: number,
  directorId: string,
): number {
  const anim = effectiveAnimatableValues(template, target, localPlayhead, directorId);
  return anim.opacity ?? base;
}

export function effectiveGradientWeight(
  template: Template,
  base: number,
  target: Target,
  prop: AnimatableProp,
  localPlayhead: number,
  directorId: string,
): number {
  const anim = effectiveAnimatableValues(template, target, localPlayhead, directorId);
  return anim[prop] ?? base;
}
