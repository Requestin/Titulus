import {
  normalizeTimeline,
  sampleAtDirectorLocals,
  directorRelToLocal,
  advanceDirectorRel,
  ANIMATABLE_PROPS,
  type AnimatableProp,
  type Template,
  type Transform,
} from '@runtime';
import type { Target } from './store';
import { directorForTrack } from './timelineTracks';

export function globalFrame(template: Template, directorId: string, localPlayhead: number): number {
  const d = template.timeline.directors.find((x) => x.id === directorId);
  return (d?.offsetFrames ?? 0) + localPlayhead;
}

export function effectiveAnimatableValues(
  template: Template,
  target: Target,
  playheads: Record<string, number>,
): Partial<Record<AnimatableProp, number>> {
  const norm = normalizeTimeline(template.timeline);
  const sample = sampleAtDirectorLocals(norm, playheads);
  return (target.kind === 'layer' ? sample.layers[target.id] : sample.groups[target.id]) ?? {};
}

/** Transform + opacity values as shown on canvas with all directors playing. */
export function effectiveTransform(
  template: Template,
  base: Transform,
  target: Target,
  playheads: Record<string, number>,
): Transform {
  const anim = effectiveAnimatableValues(template, target, playheads);
  const out = { ...base };
  for (const p of ANIMATABLE_PROPS) {
    if (p === 'opacity') continue;
    if (anim[p] !== undefined) (out as unknown as Record<string, number>)[p] = anim[p]!;
  }
  return out;
}

export function effectiveOpacity(
  template: Template,
  base: number,
  target: Target,
  playheads: Record<string, number>,
): number {
  const anim = effectiveAnimatableValues(template, target, playheads);
  return anim.opacity ?? base;
}

/** Properties panel: sample one director's playhead for the selected target. */
export function effectiveTransformForDirector(
  template: Template,
  base: Transform,
  target: Target,
  localPlayhead: number,
  directorId: string,
): Transform {
  const playheads = { [directorId]: localPlayhead };
  return effectiveTransform(template, base, target, playheads);
}

export function effectiveOpacityForDirector(
  template: Template,
  base: number,
  target: Target,
  localPlayhead: number,
  directorId: string,
): number {
  const playheads = { [directorId]: localPlayhead };
  return effectiveOpacity(template, base, target, playheads);
}

export { directorRelToLocal, advanceDirectorRel, directorForTrack };
