import { ANIMATABLE_PROPS, type AnimatableProp, type Template } from '@runtime';
import type { Target } from '../store';
import { pointsFor, type TimelineTrack } from '../timelineTracks';
import type { KeyframeHit } from '../timelineMarquee';

export const HEADER_W = 168;
export const RULER_H = 24;
export const LANE_H = 26;
export const GROUP_HDR_H = 20;
export const ACTION_LANE_H = 22;

export const TIMELINE_ANIMATABLE_PROPS = [...ANIMATABLE_PROPS, 'z'] as const satisfies readonly AnimatableProp[];

export type GroupLaneRow = {
  kind: 'group';
  target: Target;
  label: string;
  y: number;
  height: number;
  start: number;
  end: number;
};

export type TrackLaneRow = {
  kind: 'track';
  target: Target;
  prop: AnimatableProp;
  y: number;
  height: number;
};

export type LaneRow = GroupLaneRow | TrackLaneRow;

export function buildLaneLayout(
  template: Template,
  tracks: TimelineTrack[],
  _pxPerFrame: number,
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
    rows.push({ kind: 'group', target, label, y, height: GROUP_HDR_H, start, end });
    y += GROUP_HDR_H;
    for (const track of groupTracks) {
      rows.push({ kind: 'track', target: track.target, prop: track.prop, y, height: LANE_H });
      y += LANE_H;
    }
  }
  return { rows, height: y };
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
