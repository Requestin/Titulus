// frontend/src/editor/videoTimeline.ts
// Place / move video clips on the default (or current) director via videoProgress tracks.

import {
  extractAssetId,
  resolveBinding,
  timelineTrackKey,
  type Template,
  type TimelineKeyframe,
  type VideoLayer,
} from '@runtime';
import { api } from '@/core/api';
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

/** Resolve media duration in timeline frames (template fps). */
export async function resolveVideoDurationFrames(
  src: string,
  timelineFps: number,
  fallbackFrames?: number,
): Promise<number> {
  const fps = Math.max(1, timelineFps || 50);
  const fallback = fallbackFrames && fallbackFrames > 0
    ? Math.max(1, Math.round(fallbackFrames))
    : Math.round(fps * 5);

  const trimmed = src.trim();
  if (!trimmed) return fallback;

  try {
    const id = extractAssetId(trimmed);
    const asset = id
      ? await api.media.get(id)
      : await api.media.lookup(trimmed);
    if (asset.type === 'video') {
      if (asset.durationSec != null && asset.durationSec > 0) {
        return Math.max(1, Math.round(asset.durationSec * fps));
      }
      if (asset.durationFrames != null && asset.durationFrames > 0) {
        const srcFps = Math.max(1, asset.fps || fps);
        return Math.max(1, Math.round(asset.durationFrames * (fps / srcFps)));
      }
    }
  } catch {
    // keep fallback
  }
  return fallback;
}

export function videoClipNeedsUpdate(
  template: Template,
  layer: VideoLayer,
  durationFrames: number,
): boolean {
  const dur = Math.max(1, Math.round(durationFrames));
  const win = getVideoClipWindow(template, layer.id);
  if (!win) return true;
  if (win.end - win.start !== dur) return true;
  if (layer.durationFrames !== dur) return true;
  return false;
}

export interface VideoClipPlanItem {
  layerId: string;
  durationFrames: number;
}

/**
 * Build a plan of video layers that need a (re)placed clip for the resolved src.
 * Start frame is preserved by placeVideoClipOnTimeline when applying.
 */
export async function planVideoClipsForVariables(
  template: Template,
  variables: Record<string, string | number>,
): Promise<VideoClipPlanItem[]> {
  const fps = template.timeline.fps || 50;
  const plan: VideoClipPlanItem[] = [];
  for (const layer of template.layers) {
    if (layer.type !== 'video') continue;
    const src = String(resolveBinding(layer.src, variables, '')).trim();
    if (!src) continue;
    const durationFrames = await resolveVideoDurationFrames(src, fps, layer.durationFrames);
    if (!videoClipNeedsUpdate(template, layer, durationFrames)) continue;
    plan.push({ layerId: layer.id, durationFrames });
  }
  return plan;
}

/** Apply a plan in-place. Keeps existing clip start when re-placing. */
export function applyVideoClipPlan(template: Template, plan: VideoClipPlanItem[]): boolean {
  if (plan.length === 0) return false;
  let mutated = false;
  for (const item of plan) {
    const layer = template.layers.find((l) => l.id === item.layerId && l.type === 'video') as VideoLayer | undefined;
    if (!layer) continue;
    placeVideoClipOnTimeline(template, layer, item.durationFrames);
    mutated = true;
  }
  return mutated;
}

/**
 * Ensure every video layer with a resolved src has a movable videoProgress clip.
 * Re-places when duration changes; keeps prior start frame.
 */
export async function ensureVideoClipsForVariables(
  template: Template,
  variables: Record<string, string | number>,
): Promise<boolean> {
  const plan = await planVideoClipsForVariables(template, variables);
  return applyVideoClipPlan(template, plan);
}
