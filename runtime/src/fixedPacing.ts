/**
 * Fixed-mode timeline scheduler used by channel.html's BeginFrame heartbeat.
 *
 * `one_tick` is a P20.3 research mode: it deliberately trades wall-time
 * catch-up for one logical pose per observed BeginFrame, so cadence evidence
 * cannot be obscured by a 2/0 accumulator pattern.
 */
export type FixedPacingMode = 'accumulator' | 'one_tick';

export interface FixedPacingState {
  accumulatedMs: number;
  lastTickMs: number | null;
}

export function nextFixedTickCount(
  state: FixedPacingState,
  timestampMs: number,
  fps: number,
  mode: FixedPacingMode,
): number {
  if (!Number.isFinite(timestampMs)) throw new Error('timestampMs must be finite');
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('fps must be positive');

  if (mode === 'one_tick') {
    state.lastTickMs = timestampMs;
    state.accumulatedMs = 0;
    return 1;
  }

  const stepMs = 1000 / fps;
  if (state.lastTickMs === null) {
    state.lastTickMs = timestampMs;
    return 0;
  }
  state.accumulatedMs += Math.max(0, timestampMs - state.lastTickMs);
  state.lastTickMs = timestampMs;
  state.accumulatedMs = Math.min(state.accumulatedMs, stepMs * 4);

  const ticks = Math.floor(state.accumulatedMs / stepMs);
  state.accumulatedMs -= ticks * stepMs;
  return ticks;
}
