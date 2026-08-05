import {
  ANIMATABLE_PROPS,
  resolveTrackDirector,
  timelineTrackKey,
  type AnimatableProp,
  type Template,
} from '@runtime';
import type { Target } from './store';

export interface TimelineTrack {
  target: Target;
  prop: AnimatableProp;
}

export interface TimelineObjectGroup {
  target: Target;
  tracks: TimelineTrack[];
}

export interface DirectorObjectTree {
  directorId: string;
  objects: TimelineObjectGroup[];
}

export function trackKey(target: Target, prop: AnimatableProp): string {
  return timelineTrackKey(target, prop);
}

export function objectTrackKey(target: Target): string {
  return `object:${target.kind}:${target.id}`;
}

export function parseObjectTrackKey(key: string): Target | null {
  if (!key.startsWith('object:')) return null;
  const parts = key.split(':');
  if (parts.length !== 3) return null;
  const kind = parts[1] as 'layer' | 'group';
  if (kind !== 'layer' && kind !== 'group') return null;
  return { kind, id: parts[2]! };
}

export function parseTrackKey(key: string): TimelineTrack | null {
  const parts = key.split(':');
  if (parts.length < 3) return null;
  const prop = parts.slice(2).join(':') as AnimatableProp;
  const kind = parts[0] as 'layer' | 'group';
  if (kind !== 'layer' && kind !== 'group') return null;
  return { target: { kind, id: parts[1]! }, prop };
}

export function targetLabel(template: Template, target: Target): string {
  if (target.kind === 'layer') {
    return template.layers.find((l) => l.id === target.id)?.name ?? target.id;
  }
  return template.groups.find((g) => g.id === target.id)?.name ?? target.id;
}

export function directorForTrack(template: Template, track: TimelineTrack): string {
  return (
    resolveTrackDirector(template.timeline, track.target, track.prop)
    ?? template.timeline.directors[0]?.id
    ?? 'default'
  );
}

/** First director that owns any animated prop on this target (for editor focus). */
export function primaryDirectorForTarget(template: Template, target: Target): string {
  for (const k of template.timeline.keyframes) {
    const bag = (target.kind === 'layer' ? k.layers : k.groups)[target.id];
    if (!bag) continue;
    for (const prop of Object.keys(bag) as AnimatableProp[]) {
      return directorForTrack(template, { target, prop });
    }
  }
  return template.timeline.directors[0]?.id ?? 'default';
}

export function collectAllTracks(template: Template): TimelineTrack[] {
  const seen = new Set<string>();
  const tracks: TimelineTrack[] = [];

  for (const k of template.timeline.keyframes) {
    for (const [id, bag] of Object.entries(k.layers)) {
      for (const prop of Object.keys(bag) as AnimatableProp[]) {
        const key = trackKey({ kind: 'layer', id }, prop);
        if (!seen.has(key)) {
          seen.add(key);
          tracks.push({ target: { kind: 'layer', id }, prop });
        }
      }
    }
    for (const [id, bag] of Object.entries(k.groups)) {
      for (const prop of Object.keys(bag) as AnimatableProp[]) {
        const key = trackKey({ kind: 'group', id }, prop);
        if (!seen.has(key)) {
          seen.add(key);
          tracks.push({ target: { kind: 'group', id }, prop });
        }
      }
    }
  }

  return tracks;
}

function defaultTrackSort(a: TimelineTrack, b: TimelineTrack, template: Template): number {
  const byName = targetLabel(template, a.target).localeCompare(targetLabel(template, b.target));
  if (byName !== 0) return byName;
  return ANIMATABLE_PROPS.indexOf(a.prop) - ANIMATABLE_PROPS.indexOf(b.prop);
}

function targetIdentity(a: Target, b: Target): boolean {
  return a.kind === b.kind && a.id === b.id;
}

function groupTracksByObject(
  tracks: TimelineTrack[],
  template: Template,
  directorId: string,
): TimelineObjectGroup[] {
  const order = template.timeline.trackOrder?.[directorId];
  const rank = order?.length
    ? new Map(order.map((k, i) => [k, i]))
    : null;

  const sorted = [...tracks].sort((a, b) => {
    if (rank) {
      const ra = rank.get(trackKey(a.target, a.prop));
      const rb = rank.get(trackKey(b.target, b.prop));
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
    }
    return defaultTrackSort(a, b, template);
  });

  // Group by target while preserving first-seen object order from sorted list.
  const groups: TimelineObjectGroup[] = [];
  const indexByTarget = new Map<string, number>();

  for (const track of sorted) {
    const tid = `${track.target.kind}:${track.target.id}`;
    const existing = indexByTarget.get(tid);
    if (existing === undefined) {
      indexByTarget.set(tid, groups.length);
      groups.push({ target: track.target, tracks: [track] });
    } else {
      groups[existing]!.tracks.push(track);
    }
  }

  // Within each object, sort props by trackOrder / ANIMATABLE_PROPS.
  for (const g of groups) {
    g.tracks.sort((a, b) => {
      if (rank) {
        const ra = rank.get(trackKey(a.target, a.prop));
        const rb = rank.get(trackKey(b.target, b.prop));
        if (ra !== undefined && rb !== undefined) return ra - rb;
        if (ra !== undefined) return -1;
        if (rb !== undefined) return 1;
      }
      return ANIMATABLE_PROPS.indexOf(a.prop) - ANIMATABLE_PROPS.indexOf(b.prop);
    });
  }

  return groups;
}

/** Tracks grouped by director in display order. */
export function collectDirectorTree(template: Template): Array<{ directorId: string; tracks: TimelineTrack[] }> {
  const all = collectAllTracks(template);
  const byDirector = new Map<string, TimelineTrack[]>();

  for (const d of template.timeline.directors) {
    byDirector.set(d.id, []);
  }

  for (const track of all) {
    const did = directorForTrack(template, track);
    if (!byDirector.has(did)) byDirector.set(did, []);
    byDirector.get(did)!.push(track);
  }

  const out: Array<{ directorId: string; tracks: TimelineTrack[] }> = [];
  for (const d of template.timeline.directors) {
    const tracks = byDirector.get(d.id) ?? [];
    const order = template.timeline.trackOrder?.[d.id];
    if (order?.length) {
      const rank = new Map(order.map((k, i) => [k, i]));
      tracks.sort((a, b) => {
        const ra = rank.get(trackKey(a.target, a.prop));
        const rb = rank.get(trackKey(b.target, b.prop));
        if (ra !== undefined && rb !== undefined) return ra - rb;
        if (ra !== undefined) return -1;
        if (rb !== undefined) return 1;
        return defaultTrackSort(a, b, template);
      });
    } else {
      tracks.sort((a, b) => defaultTrackSort(a, b, template));
    }
    out.push({ directorId: d.id, tracks });
  }
  return out;
}

/** Director tree with tracks grouped into object rows. */
export function collectDirectorObjectTree(template: Template): DirectorObjectTree[] {
  return collectDirectorTree(template).map(({ directorId, tracks }) => ({
    directorId,
    objects: groupTracksByObject(tracks, template, directorId),
  }));
}

/** Min/max frame span across all animated props of a target. */
export function targetKeyframeSpan(
  template: Template,
  target: Target,
): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const k of template.timeline.keyframes) {
    const bag = (target.kind === 'layer' ? k.layers : k.groups)[target.id];
    if (!bag) continue;
    if (Object.keys(bag).length === 0) continue;
    if (k.frame < min) min = k.frame;
    if (k.frame > max) max = k.frame;
  }
  if (!Number.isFinite(min)) return null;
  return { min, max };
}

export function sameTarget(a: Target, b: Target): boolean {
  return targetIdentity(a, b);
}

export function trackPropLabel(prop: AnimatableProp): string {
  const labels: Partial<Record<AnimatableProp, string>> = {
    z: 'Z',
    perspective: 'pers',
    rotation: 'rotationZ',
    rotationX: 'rotationX',
    rotationY: 'rotationY',
    crawlProgress: 'Crawl',
    videoProgress: 'Video',
    UpperLeft: 'UpperLeft',
    LowerLeft: 'LowerLeft',
    UpperRight: 'UpperRight',
    LowerRight: 'LowerRight',
  };
  return labels[prop] ?? prop;
}
