import type { AnimatableProp } from '@runtime';
import type { Target } from './store';
import { keyframeKey, type SelectedKeyframe } from './timelineTracks';

export type MarqueeRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type KeyframeHit = {
  target: Target;
  prop: AnimatableProp;
  frame: number;
  x: number;
  y: number;
  directorId?: string;
};

export function normalizeMarquee(x0: number, y0: number, x1: number, y1: number): MarqueeRect {
  return {
    left: Math.min(x0, x1),
    top: Math.min(y0, y1),
    right: Math.max(x0, x1),
    bottom: Math.max(y0, y1),
  };
}

export function keyframesInMarquee(hits: KeyframeHit[], rect: MarqueeRect): SelectedKeyframe[] {
  return hits
    .filter((hit) => (
      hit.x >= rect.left
      && hit.x <= rect.right
      && hit.y >= rect.top
      && hit.y <= rect.bottom
    ))
    .map((hit) => (
      hit.directorId
        ? { target: hit.target, prop: hit.prop, frame: hit.frame, directorId: hit.directorId }
        : { target: hit.target, prop: hit.prop, frame: hit.frame }
    ));
}

export function toggleKeyframeSelection(
  current: SelectedKeyframe[],
  clicked: SelectedKeyframe,
  mode: 'replace' | 'add' | 'toggle',
): SelectedKeyframe[] {
  const clickedKey = keyframeKey(clicked);
  if (mode === 'replace') return [clicked];
  const exists = current.some((item) => keyframeKey(item) === clickedKey);
  if (mode === 'add') return exists ? current : [...current, clicked];
  return exists
    ? current.filter((item) => keyframeKey(item) !== clickedKey)
    : [...current, clicked];
}
