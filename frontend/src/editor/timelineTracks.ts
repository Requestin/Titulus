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

export function trackKey(target: Target, prop: AnimatableProp): string {
  return timelineTrackKey(target, prop);
}

export function parseTrackKey(key: string): TimelineTrack | null {
  const parts = key.split(':');
  if (parts.length < 3) return null;
  const prop = parts.slice(2).join(':') as AnimatableProp;
  const kind = parts[0] as 'layer' | 'group';
  if (kind !== 'layer' && kind !== 'group') return null;
  return { target: { kind, id: parts[1] }, prop };
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

export function trackPropLabel(prop: AnimatableProp): string {
  const labels: Partial<Record<AnimatableProp, string>> = {
    rotation: 'rotationZ',
    rotationX: 'rotationX',
    rotationY: 'rotationY',
    crawlProgress: 'Crawl',
  };
  return labels[prop] ?? prop;
}
