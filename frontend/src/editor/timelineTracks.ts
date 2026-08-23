import {
  ANIMATABLE_PROPS,
  VNEXT_ANIMATABLE_PROPS,
  type AnimatableProp,
  type EasingType,
  type Template,
  type Timeline,
  type TimelineKeyframe,
} from '@runtime';
import { createId } from '@/core/id';
import type { Target } from './store';

export type TimelineTrack = { target: Target; prop: AnimatableProp };

export type TrackGroup = {
  target: Target;
  label: string;
  tracks: { prop: AnimatableProp }[];
};

export type KeyframePoint = {
  frame: number;
  value: number;
  easing: EasingType;
};

export type SelectedKeyframe = {
  target: Target;
  prop: AnimatableProp;
  frame: number;
};

export type PlannedMove = {
  target: Target;
  prop: AnimatableProp;
  fromFrame: number;
  toFrame: number;
  value: number;
};

const PROP_ORDER = [...ANIMATABLE_PROPS, ...VNEXT_ANIMATABLE_PROPS] as readonly AnimatableProp[];

export function trackKey(target: Target, prop: AnimatableProp): string {
  return `${target.kind}:${target.id}:${prop}`;
}

export function keyframeKey(kf: SelectedKeyframe): string {
  return `${trackKey(kf.target, kf.prop)}@${kf.frame}`;
}

export function parseTrackKey(key: string): TimelineTrack | null {
  const match = /^(layer|group):([^:]+):(.+)$/.exec(key);
  if (!match) return null;
  return {
    target: { kind: match[1] as Target['kind'], id: match[2]! },
    prop: match[3] as AnimatableProp,
  };
}

export function targetLabel(template: Template, target: Target): string {
  if (target.kind === 'layer') {
    return template.layers.find((layer) => layer.id === target.id)?.name ?? target.id;
  }
  return template.groups.find((group) => group.id === target.id)?.name ?? target.id;
}

export function collectTracks(template: Template): TimelineTrack[] {
  const seen = new Set<string>();
  const tracks: TimelineTrack[] = [];
  for (const keyframe of template.timeline.keyframes) {
    for (const [id, bag] of Object.entries(keyframe.layers)) {
      for (const prop of Object.keys(bag) as AnimatableProp[]) {
        const key = trackKey({ kind: 'layer', id }, prop);
        if (seen.has(key)) continue;
        seen.add(key);
        tracks.push({ target: { kind: 'layer', id }, prop });
      }
    }
    for (const [id, bag] of Object.entries(keyframe.groups)) {
      for (const prop of Object.keys(bag) as AnimatableProp[]) {
        const key = trackKey({ kind: 'group', id }, prop);
        if (seen.has(key)) continue;
        seen.add(key);
        tracks.push({ target: { kind: 'group', id }, prop });
      }
    }
  }
  return tracks.sort((left, right) => {
    const byName = targetLabel(template, left.target).localeCompare(targetLabel(template, right.target));
    if (byName !== 0) return byName;
    return PROP_ORDER.indexOf(left.prop) - PROP_ORDER.indexOf(right.prop);
  });
}

export function groupTracksByTarget(template: Template, tracks: TimelineTrack[]): TrackGroup[] {
  const groups: TrackGroup[] = [];
  const map = new Map<string, TrackGroup>();
  for (const track of tracks) {
    const key = `${track.target.kind}:${track.target.id}`;
    let group = map.get(key);
    if (!group) {
      group = { target: track.target, label: targetLabel(template, track.target), tracks: [] };
      map.set(key, group);
      groups.push(group);
    }
    group.tracks.push({ prop: track.prop });
  }
  return groups;
}

export function bagFor(keyframe: TimelineKeyframe, target: Target) {
  return target.kind === 'layer' ? keyframe.layers[target.id] : keyframe.groups[target.id];
}

export function pointsFor(template: Template, target: Target, prop: AnimatableProp): KeyframePoint[] {
  const points: KeyframePoint[] = [];
  for (const keyframe of template.timeline.keyframes) {
    const value = bagFor(keyframe, target)?.[prop];
    if (value === undefined) continue;
    points.push({ frame: keyframe.frame, value, easing: keyframe.easing });
  }
  return points.sort((left, right) => left.frame - right.frame);
}

export function directorForTrack(timeline: Timeline, target: Target, prop: AnimatableProp): string {
  return timeline.propertyTrackDirectors?.[target.id]?.[prop]
    ?? timeline.trackDirectors[target.id]
    ?? 'default';
}

export function assignPropertyDirector(
  timeline: Timeline,
  target: Target,
  prop: AnimatableProp,
  directorId: string,
): void {
  const objectDirector = timeline.trackDirectors[target.id] ?? 'default';
  if (directorId === objectDirector) {
    const bag = timeline.propertyTrackDirectors?.[target.id];
    if (!bag) return;
    delete bag[prop];
    if (Object.keys(bag).length === 0) delete timeline.propertyTrackDirectors![target.id];
    if (timeline.propertyTrackDirectors && Object.keys(timeline.propertyTrackDirectors).length === 0) {
      delete timeline.propertyTrackDirectors;
    }
    return;
  }
  timeline.propertyTrackDirectors ??= {};
  timeline.propertyTrackDirectors[target.id] ??= {};
  timeline.propertyTrackDirectors[target.id]![prop] = directorId;
}

export function tracksForDirector(template: Template, directorId: string): TimelineTrack[] {
  return collectTracks(template).filter((track) => (
    directorForTrack(template.timeline, track.target, track.prop) === directorId
  ));
}

/**
 * Collision policy is overwrite:
 * selected sources are lifted first, destinations replace any occupant,
 * and if two selected points of one track land on the same frame the later
 * original frame wins.
 */
export function planKeyframeMoves(
  template: Template,
  selected: SelectedKeyframe[],
  deltaFrames: number,
): PlannedMove[] {
  const delta = Math.round(deltaFrames);
  if (delta === 0 || selected.length === 0) return [];
  const byTrack = new Map<string, SelectedKeyframe[]>();
  for (const keyframe of selected) {
    const key = trackKey(keyframe.target, keyframe.prop);
    const list = byTrack.get(key) ?? [];
    list.push(keyframe);
    byTrack.set(key, list);
  }
  const moves: PlannedMove[] = [];
  for (const group of byTrack.values()) {
    const winner = new Map<number, SelectedKeyframe>();
    for (const keyframe of group) {
      const toFrame = Math.max(0, Math.round(keyframe.frame + delta));
      const previous = winner.get(toFrame);
      if (!previous || keyframe.frame >= previous.frame) winner.set(toFrame, keyframe);
    }
    for (const [toFrame, keyframe] of winner) {
      if (toFrame === keyframe.frame) continue;
      const point = pointsFor(template, keyframe.target, keyframe.prop)
        .find((item) => item.frame === keyframe.frame);
      if (!point) continue;
      moves.push({
        target: keyframe.target,
        prop: keyframe.prop,
        fromFrame: keyframe.frame,
        toFrame,
        value: point.value,
      });
    }
  }
  return moves.sort((left, right) => (
    left.fromFrame - right.fromFrame
    || trackKey(left.target, left.prop).localeCompare(trackKey(right.target, right.prop))
  ));
}

export function kfAt(template: Template, frame: number): TimelineKeyframe {
  const snapped = Math.round(frame);
  let keyframe = template.timeline.keyframes.find((item) => item.frame === snapped);
  if (!keyframe) {
    keyframe = { id: createId(), frame: snapped, layers: {}, groups: {}, easing: 'power2.out' };
    template.timeline.keyframes.push(keyframe);
    template.timeline.keyframes.sort((left, right) => left.frame - right.frame);
  }
  return keyframe;
}

export function pruneKf(template: Template, keyframe: TimelineKeyframe): void {
  if (Object.keys(keyframe.layers).length === 0 && Object.keys(keyframe.groups).length === 0) {
    template.timeline.keyframes = template.timeline.keyframes.filter((item) => item !== keyframe);
  }
}

export function writePoint(
  template: Template,
  target: Target,
  frame: number,
  prop: AnimatableProp,
  value: number,
): void {
  const keyframe = kfAt(template, frame);
  const section = target.kind === 'layer' ? keyframe.layers : keyframe.groups;
  (section[target.id] ??= {})[prop] = value;
}

export function erasePoint(
  template: Template,
  target: Target,
  frame: number,
  prop: AnimatableProp,
): void {
  const keyframe = template.timeline.keyframes.find((item) => item.frame === frame);
  if (!keyframe) return;
  const section = target.kind === 'layer' ? keyframe.layers : keyframe.groups;
  const bag = section[target.id];
  if (!bag || bag[prop] === undefined) return;
  delete bag[prop];
  if (Object.keys(bag).length === 0) delete section[target.id];
  pruneKf(template, keyframe);
}

export function applyKeyframeMoves(template: Template, moves: PlannedMove[]): void {
  for (const move of moves) {
    erasePoint(template, move.target, move.fromFrame, move.prop);
  }
  for (const move of moves) {
    writePoint(template, move.target, move.toFrame, move.prop, move.value);
  }
}

export function retargetSelected(
  selected: SelectedKeyframe[],
  moves: PlannedMove[],
): SelectedKeyframe[] {
  return selected.map((key) => {
    const move = moves.find((item) => (
      item.target.kind === key.target.kind
      && item.target.id === key.target.id
      && item.prop === key.prop
      && item.fromFrame === key.frame
    ));
    return move ? { ...key, frame: move.toFrame } : key;
  });
}
