// runtime/src/directorRuntime.ts
//
// Per-director play state for timeline Actions (start/stop/pause/continue).

import type { Timeline, TimelineDirector, TimelineActionCue, TimelineActionItem, TimelineActionDirection } from './schema.js';

export type DirectorPlayState = 'play' | 'stop' | 'stopAndWaitContinue' | 'pause';

export interface DirectorRuntime {
  state: DirectorPlayState;
  /** Local playhead within the director (0..durationFrames). */
  localFrame: number;
  /** +1 normal, -1 reverse. */
  direction: 1 | -1;
  pauseRemaining: number;
  lastLocalForActions: number | null;
}

export function initDirectorRuntimes(timeline: Timeline): Record<string, DirectorRuntime> {
  const out: Record<string, DirectorRuntime> = {};
  for (const d of timeline.directors) {
    out[d.id] = {
      state: d.autostart ? 'play' : 'stop',
      localFrame: 0,
      direction: 1,
      pauseRemaining: 0,
      lastLocalForActions: null,
    };
  }
  return out;
}

export function directionAllows(itemDir: TimelineActionDirection, moving: 1 | -1): boolean {
  if (itemDir === 'both') return true;
  if (itemDir === 'normal') return moving === 1;
  return moving === -1;
}

/** Advance one playing director by one frame; honor loop/swing at ends. */
export function advanceDirectorLocal(d: TimelineDirector, rt: DirectorRuntime): void {
  if (rt.state !== 'play') return;
  let next = rt.localFrame + rt.direction;
  const max = d.durationFrames;

  if (next < 0) {
    if (d.loop) {
      if (d.swing) {
        rt.direction = 1;
        next = 0;
      } else {
        next = max;
      }
    } else {
      next = 0;
      rt.state = 'stop';
    }
  } else if (next > max) {
    if (d.loop) {
      if (d.swing) {
        rt.direction = -1;
        next = max;
      } else {
        next = 0;
      }
    } else {
      next = max;
      rt.state = 'stop';
    }
  }
  rt.localFrame = next;
}

export function tickPause(rt: DirectorRuntime): void {
  if (rt.state !== 'pause') return;
  if (rt.pauseRemaining <= 0) {
    rt.state = 'play';
    rt.pauseRemaining = 0;
    return;
  }
  rt.pauseRemaining -= 1;
  if (rt.pauseRemaining <= 0) {
    rt.state = 'play';
    rt.pauseRemaining = 0;
  }
}

export function localFramesMap(runtimes: Record<string, DirectorRuntime>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, rt] of Object.entries(runtimes)) out[id] = rt.localFrame;
  return out;
}

export type FiredAction = {
  cue: TimelineActionCue;
  item: TimelineActionItem;
  directorId: string;
  localFrame: number;
};

/** Collect items that should fire for crossed cues given movement direction. */
export function collectFiredItems(
  cues: TimelineActionCue[],
  prevLocal: number | null,
  curLocal: number,
  moving: 1 | -1,
): FiredAction[] {
  const fired: FiredAction[] = [];
  for (const cue of cues) {
    const crossed = prevLocal === null
      ? cue.frame <= curLocal
      : (moving === 1
        ? prevLocal < cue.frame && cue.frame <= curLocal
        : curLocal <= cue.frame && cue.frame < prevLocal);
    if (!crossed) continue;
    for (const item of cue.items) {
      if (!item.command) continue;
      if (!directionAllows(item.direction, moving)) continue;
      fired.push({ cue, item, directorId: cue.directorId, localFrame: curLocal });
    }
  }
  return fired;
}
