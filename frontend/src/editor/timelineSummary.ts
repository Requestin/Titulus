import type { Template } from '@runtime';
import type { Target } from './store';
import {
  applyKeyframeMoves,
  collectTracks,
  pointsFor,
  type PlannedMove,
  type SelectedKeyframe,
  trackKey,
} from './timelineTracks';

export type SummaryRange = {
  target: Target;
  start: number;
  end: number;
  keys: SelectedKeyframe[];
};

export function objectSummary(template: Template, target: Target): SummaryRange | null {
  const keys: SelectedKeyframe[] = [];
  for (const track of collectTracks(template)) {
    if (track.target.kind !== target.kind || track.target.id !== target.id) continue;
    for (const point of pointsFor(template, track.target, track.prop)) {
      keys.push({ target: track.target, prop: track.prop, frame: point.frame });
    }
  }
  if (keys.length === 0) return null;
  const frames = keys.map((key) => key.frame);
  return {
    target,
    start: Math.min(...frames),
    end: Math.max(...frames),
    keys,
  };
}

export function stretchSummaryKeys(
  keys: SelectedKeyframe[],
  edge: 'start' | 'end',
  newEdgeFrame: number,
): SelectedKeyframe[] {
  if (keys.length === 0) return [];
  const start = Math.min(...keys.map((key) => key.frame));
  const end = Math.max(...keys.map((key) => key.frame));
  const nextEdge = Math.max(0, Math.round(newEdgeFrame));
  if (start === end) {
    return keys.map((key) => ({ ...key, frame: nextEdge }));
  }
  if (edge === 'end') {
    const span = end - start;
    return keys.map((key) => ({
      ...key,
      frame: Math.max(0, Math.round(start + ((key.frame - start) / span) * (nextEdge - start))),
    }));
  }
  const span = end - start;
  return keys.map((key) => ({
    ...key,
    frame: Math.max(0, Math.round(nextEdge + ((key.frame - start) / span) * (end - nextEdge))),
  }));
}

export function planStretchMoves(
  template: Template,
  keys: SelectedKeyframe[],
  edge: 'start' | 'end',
  newEdgeFrame: number,
): PlannedMove[] {
  const stretched = stretchSummaryKeys(keys, edge, newEdgeFrame);
  const winner = new Map<string, PlannedMove>();
  for (let index = 0; index < keys.length; index += 1) {
    const from = keys[index]!;
    const to = stretched[index]!;
    const point = pointsFor(template, from.target, from.prop).find((item) => item.frame === from.frame);
    if (!point || from.frame === to.frame) continue;
    const destKey = `${trackKey(from.target, from.prop)}->${to.frame}`;
    const previous = winner.get(destKey);
    if (previous && from.frame < previous.fromFrame) continue;
    winner.set(destKey, {
      target: from.target,
      prop: from.prop,
      fromFrame: from.frame,
      toFrame: to.frame,
      value: point.value,
    });
  }
  return [...winner.values()].sort((left, right) => left.fromFrame - right.fromFrame);
}

export function applyObjectStretch(
  template: Template,
  target: Target,
  edge: 'start' | 'end',
  newEdgeFrame: number,
): PlannedMove[] {
  const summary = objectSummary(template, target);
  if (!summary) return [];
  const moves = planStretchMoves(template, summary.keys, edge, newEdgeFrame);
  applyKeyframeMoves(template, moves);
  return moves;
}
