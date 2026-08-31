import { type AnimatableProp, type Template, type TimelineDirector } from '@runtime';
import type { Target } from '../store';
import { pointsFor, tracksForDirector, type TimelineTrack } from '../timelineTracks';
import type { KeyframeHit } from '../timelineMarquee';

export const HEADER_W = 168;
export const RULER_H = 24;
export const LANE_H = 26;
export const GROUP_HDR_H = 20;
export const DIRECTOR_HDR_H = 24;
export const ACTION_LANE_H = 22;

/** Addable / sortable timeline props: z sits after y; crawlProgress last. */
export const TIMELINE_ANIMATABLE_PROPS = [
  'x', 'y', 'z',
  'width', 'height',
  'rotation', 'rotationX', 'rotationY', 'perspective',
  'scaleX', 'scaleY',
  'opacity',
  'crawlProgress',
] as const satisfies readonly AnimatableProp[];

export function timelinePropLabel(prop: AnimatableProp): string {
  if (prop === 'rotation') return 'rotationZ';
  return prop;
}

export type DirectorLaneRow = {
  kind: 'director';
  directorId: string;
  label: string;
  collapsed: boolean;
  y: number;
  height: number;
};

export type GroupLaneRow = {
  kind: 'group';
  target: Target;
  label: string;
  y: number;
  height: number;
  start: number;
  end: number;
  collapsed: boolean;
};

export type TrackLaneRow = {
  kind: 'track';
  target: Target;
  prop: AnimatableProp;
  y: number;
  height: number;
};

export type LaneRow = DirectorLaneRow | GroupLaneRow | TrackLaneRow;

export function buildLaneLayout(
  template: Template,
  tracks: TimelineTrack[],
  _pxPerFrame: number,
  collapsedObjects: ReadonlySet<string> = new Set(),
): { rows: LaneRow[]; height: number } {
  void _pxPerFrame;
  const rows: LaneRow[] = [];
  let y = 0;
  const groups = new Map<string, TimelineTrack[]>();
  const order: string[] = [];
  for (const track of tracks) {
    const key = `${track.target.kind}:${track.target.id}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(track);
  }
  for (const key of order) {
    const groupTracks = groups.get(key)!;
    const target = groupTracks[0]!.target;
    const frames = groupTracks.flatMap((track) => pointsFor(template, track.target, track.prop).map((point) => point.frame));
    const start = frames.length ? Math.min(...frames) : 0;
    const end = frames.length ? Math.max(...frames) : 0;
    const label = target.kind === 'layer'
      ? template.layers.find((layer) => layer.id === target.id)?.name ?? target.id
      : template.groups.find((group) => group.id === target.id)?.name ?? target.id;
    const collapsed = collapsedObjects.has(key);
    rows.push({ kind: 'group', target, label, y, height: GROUP_HDR_H, start, end, collapsed });
    y += GROUP_HDR_H;
    if (collapsed) continue;
    for (const track of groupTracks) {
      rows.push({ kind: 'track', target: track.target, prop: track.prop, y, height: LANE_H });
      y += LANE_H;
    }
  }
  return { rows, height: y };
}

/** Stack every director as a collapsible folder of its tracks. */
export function buildAllDirectorsLaneLayout(
  template: Template,
  directors: TimelineDirector[],
  collapsedDirectors: ReadonlySet<string>,
  pxPerFrame: number,
  collapsedObjects: ReadonlySet<string> = new Set(),
): { rows: LaneRow[]; height: number } {
  const rows: LaneRow[] = [];
  let y = 0;
  for (const director of directors) {
    const collapsed = collapsedDirectors.has(director.id);
    rows.push({
      kind: 'director',
      directorId: director.id,
      label: director.name,
      collapsed,
      y,
      height: DIRECTOR_HDR_H,
    });
    y += DIRECTOR_HDR_H;
    if (collapsed) continue;
    const tracks = tracksForDirector(template, director.id).filter((track) => {
      if (track.prop !== 'crawlProgress') return true;
      if (track.target.kind !== 'layer') return false;
      const layer = template.layers.find((item) => item.id === track.target.id);
      return layer?.type === 'crawl';
    });
    const nested = buildLaneLayout(template, tracks, pxPerFrame, collapsedObjects);
    for (const row of nested.rows) {
      if (row.kind === 'director') continue;
      rows.push({ ...row, y } as LaneRow);
      y += row.height;
    }
  }
  return { rows, height: y };
}

/** Vertical span of each director folder (header + nested rows). */
export function directorLaneSpans(
  rows: LaneRow[],
): Array<{ directorId: string; y: number; height: number }> {
  const spans: Array<{ directorId: string; y: number; height: number }> = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.kind !== 'director') continue;
    let end = row.y + row.height;
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j]!.kind === 'director') break;
      end = rows[j]!.y + rows[j]!.height;
    }
    spans.push({ directorId: row.directorId, y: row.y, height: end - row.y });
  }
  return spans;
}

export function keyframeHits(template: Template, rows: LaneRow[], pxPerFrame: number): KeyframeHit[] {
  const hits: KeyframeHit[] = [];
  for (const row of rows) {
    if (row.kind !== 'track') continue;
    for (const point of pointsFor(template, row.target, row.prop)) {
      hits.push({
        target: row.target,
        prop: row.prop,
        frame: point.frame,
        x: point.frame * pxPerFrame,
        y: row.y + row.height / 2,
      });
    }
  }
  return hits;
}

export type TimelineDragPayload =
  | { type: 'track'; target: Target; prop: AnimatableProp }
  | { type: 'object'; target: Target };

export function serializeTimelineDrag(payload: TimelineDragPayload): string {
  return JSON.stringify({ kind: 'titulus-timeline', ...payload });
}

export function parseTimelineDrag(data: string): TimelineDragPayload | null {
  try {
    const parsed = JSON.parse(data) as { kind?: string; type?: string; target?: Target; prop?: AnimatableProp };
    if (parsed.kind !== 'titulus-timeline' || !parsed.target) return null;
    if (parsed.type === 'track' && parsed.prop) {
      return { type: 'track', target: parsed.target, prop: parsed.prop };
    }
    if (parsed.type === 'object') return { type: 'object', target: parsed.target };
    return null;
  } catch {
    return null;
  }
}
