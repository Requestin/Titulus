// frontend/src/editor/crawlTimeline.ts
// Helpers to sync Crawl layers with their dedicated timeline directors + Crawl track.

import {
  estimateCrawlDurationFrames,
  resolveBinding,
  resolveVariableMap,
  splitCrawlLines,
  timelineTrackKey,
  type CrawlLayer,
  type Template,
  type TimelineKeyframe,
} from '@runtime';
import { createId } from '@/core/id';

export function crawlContentString(template: Template, layer: CrawlLayer): string {
  const vars = resolveVariableMap(template);
  return String(resolveBinding(layer.content, vars, ''));
}

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

/**
 * Ensure the Crawl director has a visible `crawlProgress` track (0 → 1 over
 * director duration) so TimelinePanel shows a "Crawl" track under the director.
 */
export function ensureCrawlProgressTrack(template: Template, layer: CrawlLayer): void {
  const dir = template.timeline.directors.find((d) => d.id === layer.crawlDirectorId);
  if (!dir) return;

  const trackKey = timelineTrackKey({ kind: 'layer', id: layer.id }, 'crawlProgress');
  template.timeline.trackDirectors[trackKey] = dir.id;
  template.timeline.trackOrder ??= {};
  const order = template.timeline.trackOrder[dir.id] ??= [];
  if (!order.includes(trackKey)) order.unshift(trackKey);

  const start = 0; // director-local keyframes (not global offset)
  const end = Math.max(1, dir.durationFrames);

  // Drop existing crawlProgress keys for this layer (we'll recreate endpoints).
  for (const kf of template.timeline.keyframes) {
    const bag = kf.layers[layer.id];
    if (!bag || bag.crawlProgress === undefined) continue;
    delete bag.crawlProgress;
    if (Object.keys(bag).length === 0) delete kf.layers[layer.id];
  }
  pruneEmptyKeyframes(template);

  const kf0 = kfAt(template, start);
  (kf0.layers[layer.id] ??= {}).crawlProgress = 0;
  kf0.easing = 'linear';

  const kf1 = kfAt(template, end);
  (kf1.layers[layer.id] ??= {}).crawlProgress = 1;
  kf1.easing = 'linear';
}

export function recomputeCrawlDirectorDuration(template: Template, layer: CrawlLayer): void {
  const dir = template.timeline.directors.find((d) => d.id === layer.crawlDirectorId);
  if (!dir) return;
  const raw = crawlContentString(template, layer);
  const lines = splitCrawlLines(raw, layer.crawl.maxTextLengthEnabled, layer.crawl.maxTextLength);
  const fps = template.timeline.fps || 50;
  const frames = estimateCrawlDurationFrames({
    lines,
    crawl: layer.crawl,
    boxWidth: layer.transform.width,
    boxHeight: layer.transform.height,
    fontSize: layer.style.fontSize,
    fps,
    align: layer.style.align,
  });
  dir.durationFrames = frames;
  dir.loop = layer.crawl.animationType === 'continuous';
  dir.name = dir.name || 'Crawl';

  // Ensure template timeline spans the crawl director.
  const end = dir.offsetFrames + dir.durationFrames;
  if (end > template.timeline.durationFrames) {
    template.timeline.durationFrames = end;
  }

  ensureCrawlProgressTrack(template, layer);
}

export function removeCrawlDirector(template: Template, directorId: string): void {
  template.timeline.directors = template.timeline.directors.filter((d) => d.id !== directorId);
  template.timeline.actions = template.timeline.actions.filter(
    (a) => a.directorId !== directorId && a.targetDirectorId !== directorId,
  );
  if (template.timeline.trackOrder) delete template.timeline.trackOrder[directorId];
  for (const [key, did] of Object.entries(template.timeline.trackDirectors)) {
    if (did === directorId) delete template.timeline.trackDirectors[key];
  }
}

export function purgeCrawlDirectorsForLayers(template: Template, layerIds: string[]): void {
  const idSet = new Set(layerIds);
  for (const layer of [...template.layers]) {
    if (layer.type === 'crawl' && idSet.has(layer.id)) {
      removeCrawlDirector(template, layer.crawlDirectorId);
    }
  }
}
