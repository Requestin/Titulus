import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { TimelineDirector } from '@runtime';
import { directorLocalFrame } from '@runtime';

export interface PlayheadState {
  /** Active-director local frame (transport readout). */
  playhead: number;
  /** Monotonic global timeline frame. */
  globalPlayhead: number;
  /** Per-director local frames (manual scrub can detach from global). */
  localPlayheads: Record<string, number>;
  /** Directors whose local was scrubbed independently of global. */
  detachedLocals: Record<string, true>;
  playing: boolean;
  /** Bumped on every Play press so the RAF loop always restarts. */
  playSessionId: number;
  continueRequestId: number;
  waitingContinue: boolean;
}

export const playheadStore = createStore<PlayheadState>()(() => ({
  playhead: 0,
  globalPlayhead: 0,
  localPlayheads: {},
  detachedLocals: {},
  playing: false,
  playSessionId: 0,
  continueRequestId: 0,
  waitingContinue: false,
}));

export function usePlayhead<T>(select: (state: PlayheadState) => T): T {
  return useStore(playheadStore, select);
}

function clampLocal(frame: number, duration: number): number {
  return Math.max(0, Math.min(duration, Math.round(frame)));
}

export function localsFromGlobal(
  directors: TimelineDirector[],
  globalFrame: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of directors) {
    const local = directorLocalFrame(d, globalFrame);
    out[d.id] = local === null ? 0 : local;
  }
  return out;
}

/** Scrub the global playhead; all director locals follow (clears detach). */
export function scrubGlobalPlayhead(
  globalFrame: number,
  directors: TimelineDirector[],
  activeDirectorId: string,
): void {
  const global = Math.max(0, Math.round(globalFrame));
  const locals = localsFromGlobal(directors, global);
  const active = directors.find((d) => d.id === activeDirectorId);
  playheadStore.setState({
    globalPlayhead: global,
    localPlayheads: locals,
    detachedLocals: {},
    playhead: active ? (locals[active.id] ?? 0) : 0,
    playing: false,
  });
}

/** Scrub one director's local playhead only (detaches from global). */
export function scrubLocalPlayhead(
  directorId: string,
  localFrame: number,
  durationFrames: number,
  activeDirectorId: string,
): void {
  const local = clampLocal(localFrame, Math.max(0, durationFrames));
  playheadStore.setState((state) => ({
    localPlayheads: { ...state.localPlayheads, [directorId]: local },
    detachedLocals: { ...state.detachedLocals, [directorId]: true },
    playhead: directorId === activeDirectorId ? local : state.playhead,
    playing: false,
  }));
}

/** While playing: advance global and refresh all locals from swing/loop mapping. */
export function tickPlayhead(
  globalFrame: number,
  directors: TimelineDirector[],
  activeDirectorId: string,
): void {
  const global = Math.max(0, globalFrame);
  const locals = localsFromGlobal(directors, global);
  const active = directors.find((d) => d.id === activeDirectorId);
  playheadStore.setState({
    globalPlayhead: global,
    localPlayheads: locals,
    detachedLocals: {},
    playhead: active ? (locals[active.id] ?? 0) : 0,
  });
}

/**
 * Arm playback: reattach locals to global (from active scrub if detached),
 * restart bounded directors that sit at the end, and bump playSessionId so
 * the canvas RAF always (re)starts even if `playing` was already true.
 */
export function preparePlayStart(
  directors: TimelineDirector[],
  activeDirectorId: string,
): void {
  const state = playheadStore.getState();
  const active = directors.find((d) => d.id === activeDirectorId);
  let global = state.globalPlayhead;

  if (active) {
    const detached = Boolean(state.detachedLocals[active.id]);
    const local = detached && state.localPlayheads[active.id] !== undefined
      ? state.localPlayheads[active.id]!
      : (directorLocalFrame(active, global) ?? 0);

    // Authoring scrub: continue from the active director's local needle.
    if (detached) {
      global = active.offsetFrames + local;
    }

    if (!active.loop && !active.swing) {
      const atEnd = local >= active.durationFrames
        || (directorLocalFrame(active, global) ?? 0) >= active.durationFrames;
      if (atEnd) global = active.offsetFrames;
    }
  }

  global = Math.max(0, Math.round(global));
  if (active && global < active.offsetFrames) global = active.offsetFrames;

  const locals = localsFromGlobal(directors, global);
  playheadStore.setState((prev) => ({
    globalPlayhead: global,
    localPlayheads: locals,
    detachedLocals: {},
    playhead: active ? (locals[active.id] ?? 0) : 0,
    playing: true,
    playSessionId: prev.playSessionId + 1,
  }));
}

export function setLivePlayhead(frame: number): void {
  playheadStore.setState({ playhead: Math.max(0, Math.round(frame)) });
}

export function setLiveGlobalPlayhead(frame: number): void {
  playheadStore.setState({ globalPlayhead: Math.max(0, Math.round(frame)) });
}

export function setLivePlaying(playing: boolean): void {
  playheadStore.setState({ playing });
}

/** Keep global playhead; only switch the local readout to this director. */
export function activateDirectorPlayhead(
  directorId: string,
  directors: TimelineDirector[],
): void {
  const state = playheadStore.getState();
  const director = directors.find((item) => item.id === directorId);
  const mapped = director ? directorLocalFrame(director, state.globalPlayhead) : null;
  const local = state.detachedLocals[directorId]
    ? (state.localPlayheads[directorId] ?? 0)
    : (mapped ?? 0);
  playheadStore.setState({
    playhead: local,
    playing: false,
  });
}

export function syncPlayhead(frame: number, playing = playheadStore.getState().playing): void {
  playheadStore.setState({ playhead: Math.max(0, Math.round(frame)), playing });
}

export function syncGlobalPlayhead(frame: number): void {
  playheadStore.setState({ globalPlayhead: Math.max(0, Math.round(frame)) });
}

export function requestContinue(): void {
  playheadStore.setState((state) => ({ continueRequestId: state.continueRequestId + 1 }));
}

export function setWaitingContinue(waiting: boolean): void {
  playheadStore.setState({ waitingContinue: waiting });
}

type PlaybackControls = {
  start: () => void;
  stop: () => void;
};

let playbackControls: PlaybackControls | null = null;

/** CanvasArea binds the live renderer loop here so Play can start in the click. */
export function bindPlaybackControls(controls: PlaybackControls): () => void {
  playbackControls = controls;
  return () => {
    if (playbackControls === controls) playbackControls = null;
  };
}

export function startBoundPlayback(): void {
  playbackControls?.start();
}

export function stopBoundPlayback(): void {
  playbackControls?.stop();
}

/** Snapshot of locals for renderer seekLocals (detached overrides mapping). */
export function resolveSeekLocals(
  directors: TimelineDirector[],
  globalFrame: number,
  localPlayheads: Record<string, number>,
  detachedLocals: Record<string, true>,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const d of directors) {
    if (detachedLocals[d.id] && localPlayheads[d.id] !== undefined) {
      out[d.id] = localPlayheads[d.id]!;
      continue;
    }
    out[d.id] = directorLocalFrame(d, globalFrame);
  }
  return out;
}
