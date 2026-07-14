// runtime/src/stats.ts
//
// RenderStats: per-frame counters exposed via OnFrameFn (Phase 9.1).
// Used by the engine smoke harness (bench/run-bench.sh), the editor preview
// and the channel.html `?debug=1` overlay to prove that the dirty-check path
// in TemplateRenderer is actually skipping unchanged DOM writes (verification-
// loop rule §03). Keeping this minimal — `compositorLayers` and other engine-
// level counters are added in later phases.

export interface RenderStats {
  /** Number of style/property assignments that actually changed a value. */
  styleWrites: number;
  /** Number of style/property assignments that were skipped (value unchanged). */
  skippedWrites: number;
  /** Wall-clock time spent in applyState for this frame, in ms. */
  frameTimeMs: number;
  /** Subset of styleWrites that landed on a mask clip host (Phase 19 doc 01). */
  maskWrites: number;
  /** Number of text/clock content (textContent) updates this frame. */
  textWrites: number;
}

export function emptyRenderStats(): RenderStats {
  return { styleWrites: 0, skippedWrites: 0, frameTimeMs: 0, maskWrites: 0, textWrites: 0 };
}

/**
 * Return a fresh accumulator used internally by TemplateRenderer. Counters are
 * mutated in place during applyState and snapshotted into a frozen copy for the
 * onFrame callback so the host cannot accidentally mutate the live counters.
 */
export function createStatsAccumulator(): RenderStats {
  return emptyRenderStats();
}

/** Snapshot helper: returns a defensive copy suitable for handing to callers. */
export function snapshotStats(s: RenderStats): RenderStats {
  return {
    styleWrites: s.styleWrites,
    skippedWrites: s.skippedWrites,
    frameTimeMs: s.frameTimeMs,
    maskWrites: s.maskWrites,
    textWrites: s.textWrites,
  };
}
