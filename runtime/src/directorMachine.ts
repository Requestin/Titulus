import type { Timeline, TimelineCueItem } from './schema.js';
import {
  compileCues,
  cuesCrossed,
  normalizeTimeline,
  sampleAt,
  timelineNeedsDirectorRuntime,
  type CompiledCue,
  type NormalizedTimeline,
  type TimelineSample,
} from './timeline.js';

export type DirectorStatus = 'idle' | 'running' | 'paused' | 'waiting' | 'stopped';

interface DirectorRuntime {
  status: DirectorStatus;
  local: number;
  pauseRemaining: number;
}

export interface DirectorMachine {
  advance(globalFrame: number): TimelineSample;
  continue(): void;
  status(directorId: string): DirectorStatus;
  localFrame(directorId: string): number | null;
  waitingContinue(): boolean;
  endScene(): boolean;
  sample(): TimelineSample;
}

export function reuseOrCreateDirectorMachine(
  existing: DirectorMachine | null,
  timeline: Timeline,
  reuse: boolean,
): DirectorMachine | null {
  if (!timelineNeedsDirectorRuntime(timeline)) return null;
  if (reuse && existing) return existing;
  return createDirectorMachine(timeline);
}

export function createDirectorMachine(timeline: Timeline): DirectorMachine {
  const norm = normalizeTimeline(timeline);
  const compiled = compileCues(timeline);
  const directors = new Map<string, DirectorRuntime>();
  for (const director of timeline.directors) {
    directors.set(director.id, {
      status: director.autostart ? 'running' : 'idle',
      local: 0,
      pauseRemaining: 0,
    });
  }

  let lastGlobal: number | null = null;
  let sawEndScene = false;

  function applyItem(item: TimelineCueItem): void {
    if (item.command === 'tag') {
      if (item.parameterTag === 'endScene') sawEndScene = true;
      return;
    }
    const target = directors.get(item.parameterDirectorId);
    if (!target) return;
    if (item.command === 'startDirector') {
      if (target.status === 'idle' || target.status === 'stopped' || target.status === 'waiting') {
        target.status = 'running';
      }
      return;
    }
    if (item.command === 'stopDirector') {
      target.status = 'stopped';
      return;
    }
    if (item.command === 'stopDirectorAndWaitContinue') {
      target.status = 'waiting';
      return;
    }
    if (item.command === 'pauseDirector') {
      target.status = 'paused';
      target.pauseRemaining = Math.max(0, Math.round(item.lengthFrames));
    }
  }

  function fire(directorId: string, prevLocal: number | null, nextLocal: number): void {
    const direction = prevLocal !== null && nextLocal < prevLocal ? 'reverse' : 'normal';
    const seen = new Set<string>();
    const ordered: CompiledCue[] = [];
    for (const cue of [
      ...cuesCrossed(compiled, directorId, prevLocal, nextLocal, direction),
      ...cuesCrossed(compiled, directorId, prevLocal, nextLocal, 'both'),
    ]) {
      if (seen.has(cue.id)) continue;
      seen.add(cue.id);
      ordered.push(cue);
    }
    ordered.sort((left, right) => left.frame - right.frame);
    for (const cue of ordered) {
      for (const item of cue.items) applyItem(item);
    }
  }

  function sample(): TimelineSample {
    const overlay: TimelineSample = { directors: {}, layers: {}, groups: {} };
    for (const director of norm.directorList) {
      const state = directors.get(director.id);
      const active = Boolean(state && state.status !== 'idle');
      const sampled = !state || !active
        ? { layers: {}, groups: {}, active: false }
        : sampleDirectorAt(norm, director.id, director.offsetFrames + state.local);
      overlay.directors[director.id] = sampled;
      if (!sampled.active) continue;
      for (const [id, values] of Object.entries(sampled.layers)) {
        overlay.layers[id] = { ...(overlay.layers[id] ?? {}), ...values };
      }
      for (const [id, values] of Object.entries(sampled.groups)) {
        overlay.groups[id] = { ...(overlay.groups[id] ?? {}), ...values };
      }
    }
    return overlay;
  }

  return {
    advance(globalFrame: number): TimelineSample {
      const next = Math.max(0, Math.round(globalFrame));
      const prevGlobal = lastGlobal;
      const delta = prevGlobal === null ? next : next - prevGlobal;
      lastGlobal = next;

      for (const state of directors.values()) {
        if (state.status !== 'paused') continue;
        state.pauseRemaining -= Math.max(0, delta);
        if (state.pauseRemaining <= 0) {
          state.pauseRemaining = 0;
          state.status = 'running';
        }
      }

      const running = [...directors.entries()].filter(([, state]) => state.status === 'running');
      for (const [id, state] of running) {
        const prevLocal = prevGlobal === null ? null : state.local;
        if (delta > 0) state.local += delta;
        fire(id, prevLocal, state.local);
      }
      return sample();
    },
    continue() {
      for (const state of directors.values()) {
        if (state.status === 'waiting') state.status = 'running';
      }
    },
    status(directorId: string) {
      return directors.get(directorId)?.status ?? 'idle';
    },
    localFrame(directorId: string) {
      return directors.get(directorId)?.local ?? null;
    },
    waitingContinue() {
      for (const state of directors.values()) {
        if (state.status === 'waiting') return true;
      }
      return false;
    },
    endScene: () => sawEndScene,
    sample,
  };
}

function sampleDirectorAt(
  norm: NormalizedTimeline,
  directorId: string,
  globalFrame: number,
) {
  const director = norm.directorList.find((item) => item.id === directorId);
  if (!director) return { layers: {}, groups: {}, active: false };
  const isolated = sampleAt({ ...norm, directorList: [director] }, globalFrame);
  return isolated.directors[directorId] ?? { layers: {}, groups: {}, active: false };
}
