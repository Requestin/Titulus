/**
 * Wall-time scheduler for browser/OBS/vMix playback.
 *
 * Browser rAF follows the display refresh rate, not the template frame rate.
 * Fractional frame time must survive every callback; otherwise 120/144/240 Hz
 * displays repeatedly round sub-frame deltas to zero and freeze the timeline.
 */
export interface BrowserPacingState {
  accumulatedMs: number;
  lastTickMs: number | null;
}

export function nextBrowserTickCount(
  state: BrowserPacingState,
  timestampMs: number,
  fps: number,
): number {
  if (!Number.isFinite(timestampMs)) throw new Error('timestampMs must be finite');
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('fps must be positive');

  if (state.lastTickMs === null) {
    state.lastTickMs = timestampMs;
    return 0;
  }

  state.accumulatedMs += Math.max(0, timestampMs - state.lastTickMs);
  state.lastTickMs = timestampMs;

  const stepMs = 1000 / fps;
  const ticks = Math.floor((state.accumulatedMs + stepMs * 1e-9) / stepMs);
  state.accumulatedMs -= ticks * stepMs;
  if (state.accumulatedMs < 0 && state.accumulatedMs > -1e-7) {
    state.accumulatedMs = 0;
  }
  return ticks;
}
