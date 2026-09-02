import { resolveCueFrame } from './timeline.js';
import {
  createDefaultUpdateCue,
  createDefaultUpdateDirector,
  type Timeline,
  type TimelineDirector,
} from './schema.js';

export function isUpdateDirectorName(name: string | null | undefined): boolean {
  return name?.trim().toLowerCase() === 'update';
}

export function findUpdateDirector(
  directors: Pick<TimelineDirector, 'id' | 'name' | 'durationFrames'>[],
): Pick<TimelineDirector, 'id' | 'name' | 'durationFrames'> | undefined {
  return directors.find((director) => isUpdateDirectorName(director.name));
}

export function hasUpdateDirector(timeline: Pick<Timeline, 'directors'>): boolean {
  return Boolean(findUpdateDirector(timeline.directors));
}

/** Control only runs Update when that director actually has animation tracks. */
export function hasUpdateDirectorTracks(timeline: Timeline): boolean {
  const director = findUpdateDirector(timeline.directors);
  if (!director) return false;
  if (Object.values(timeline.trackDirectors).some((id) => id === director.id)) return true;
  const byProp = timeline.propertyTrackDirectors;
  if (!byProp) return false;
  return Object.values(byProp).some((bag) => Object.values(bag).some((id) => id === director.id));
}

export function ensureUpdateDirector(timeline: Timeline): void {
  if (findUpdateDirector(timeline.directors)) return;
  const used = new Set(timeline.directors.map((director) => director.id));
  const director = createDefaultUpdateDirector();
  let id = director.id;
  let suffix = 2;
  while (used.has(id)) {
    id = `update-${suffix}`;
    suffix += 1;
  }
  director.id = id;
  timeline.directors.push(director);
  const cue = createDefaultUpdateCue(director.id);
  cue.id = `${director.id}-data`;
  cue.items[0]!.id = `${director.id}-data-tag`;
  timeline.cues = [...(timeline.cues ?? []), cue];
}

/** Frame used for the saved template thumbnail: Preview frame tag, else mid default. */
export function resolveThumbnailFrame(timeline: Timeline): number {
  for (const cue of timeline.cues ?? []) {
    if (!cue.items.some((item) => item.command === 'tag' && item.parameterTag === 'previewFrame')) {
      continue;
    }
    const host = timeline.directors.find((director) => director.id === cue.directorId);
    return resolveCueFrame(cue, host?.durationFrames ?? timeline.durationFrames);
  }
  const fallback = timeline.directors.find((director) => director.id === 'default')
    ?? timeline.directors.find((director) => director.name.trim().toLowerCase() === 'default')
    ?? timeline.directors[0];
  const duration = fallback?.durationFrames ?? timeline.durationFrames;
  return Math.max(0, Math.round(duration / 2));
}
