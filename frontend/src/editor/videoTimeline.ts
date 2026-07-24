// frontend/src/editor/videoTimeline.ts
// Place / move video clips on the default (or current) director via videoProgress tracks.

import {
  timelineTrackKey,
  type Template,
  type TimelineKeyframe,
  type VideoLayer,
} from '@runtime';
import { createId } from '@/core/id';

function kfAt(t: Template, frame: number): TimelineKeyframe {
  let kf = t.timeline.keyframes.find((k) => k.frame === frame);
  if (!kf) {
    kf = { id: createId(), frame, layers: {}, groups: {}, easing: 'linear' };
    t.timeline.keyframes.push(kf);
    t.timeline.keyframes.sort((a, b) => a.frame - b.frame);
  }
  return kf;
}

function pruneEmptyKeyframes(t: Template): void {
  t.timeline.keyframes = t.timeline.keyframes.filter(
    (k) => Object.keys(k.layers).length > 0 || Object.keys(k.groups).length > 0,
  );
}

function clearVideoProgressKeys(t: Template, layerId: string): void {
  for (const kf of t.timeline.keyframes) {
    const bag = kf.layers[layerId];
    if (!bag || bag.videoProgress === undefined) continue;
    delete bag.videoProgress;
    if (Object.keys(bag).length === 0) delete kf.layers[layerId];
  }
  pruneEmptyKeyframes(t);
}

export function getVideoClipWindow(
  template: Template,
  layerId: string,
): { start: number; end: number } | null {
  const points: number[] = [];
  for (const kf of template.timeline.keyframes) {
    const bag = kf.layers[layerId];
    if (bag && bag.videoProgress !== undefined) points.push(kf.frame);
  }
  if (points.length < 2) return null;
  points.sort((a, b) => a - b);
  return { start: points[0]!, end: points[points.length - 1]! };
}

function defaultDirectorId(template: Template): string {
  const named = template.timeline.directors.find((d) => d.name.trim().toLowerCase() === 'default');
  return named?.id ?? template.timeline.directors[0]?.id ?? 'default';
}

/**
 * Create / replace a videoProgress track on the default director.
 * Clip length is fixed to durationFrames; start defaults to 0 (or keep prior start).
 */
export function placeVideoClipOnTimeline(
  template: Template,
  layer: VideoLayer,
  durationFrames: number,
  opts?: { startFrame?: number; directorId?: string },
): void {
  const dur = Math.max(1, Math.round(durationFrames));
  layer.durationFrames = dur;

  const prev = getVideoClipWindow(template, layer.id);
  const start = Math.max(0, Math.round(opts?.startFrame ?? prev?.start ?? 0));
  const end = start + dur;
  const directorId = opts?.directorId
    ?? (prev
      ? (template.timeline.trackDirectors[timelineTrackKey({ kind: 'layer', id: layer.id }, 'videoProgress')]
        ?? defaultDirectorId(template))
      : defaultDirectorId(template));

  clearVideoProgressKeys(template, layer.id);

  const trackKey = timelineTrackKey({ kind: 'layer', id: layer.id }, 'videoProgress');
  template.timeline.trackDirectors[trackKey] = directorId;
  template.timeline.trackOrder ??= {};
  const order = template.timeline.trackOrder[directorId] ??= [];
  if (!order.includes(trackKey)) order.unshift(trackKey);

  const kf0 = kfAt(template, start);
  (kf0.layers[layer.id] ??= {}).videoProgress = 0;
  kf0.easing = 'linear';

  const kf1 = kfAt(template, end);
  (kf1.layers[layer.id] ??= {}).videoProgress = 1;
  kf1.easing = 'linear';

  const dir = template.timeline.directors.find((d) => d.id === directorId);
  if (dir && end > dir.durationFrames) {
    dir.durationFrames = end;
  }
  if (end > template.timeline.durationFrames) {
    template.timeline.durationFrames = end;
  }
}

/** Slide the clip as a unit (fixed duration). Returns false if blocked. */
export function moveVideoClip(
  template: Template,
  layerId: string,
  deltaFrames: number,
): boolean {
  if (deltaFrames === 0) return true;
  const win = getVideoClipWindow(template, layerId);
  if (!win) return false;
  const duration = win.end - win.start;
  const nextStart = Math.max(0, win.start + deltaFrames);
  const nextEnd = nextStart + duration;

  const otherFrames = new Set<number>();
  for (const kf of template.timeline.keyframes) {
    const bag = kf.layers[layerId];
    if (!bag || bag.videoProgress === undefined) continue;
    if (kf.frame !== win.start && kf.frame !== win.end) otherFrames.add(kf.frame);
  }
  if (otherFrames.has(nextStart) || otherFrames.has(nextEnd)) return false;

  const layer = template.layers.find((l) => l.id === layerId && l.type === 'video') as VideoLayer | undefined;
  const directorId = template.timeline.trackDirectors[
    timelineTrackKey({ kind: 'layer', id: layerId }, 'videoProgress')
  ];
  if (!layer) return false;

  placeVideoClipOnTimeline(template, layer, duration, { startFrame: nextStart, directorId });
  return true;
}
