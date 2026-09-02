import { resolveCueFrame } from './timeline.js';
import type { Timeline, TimelineDirector } from './schema.js';

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
