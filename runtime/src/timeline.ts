// runtime/src/timeline.ts
//
// Frame-based timeline engine (DEVELOPMENT_PROMPT §6.2 timeline).
//
// Responsibilities:
//   - normalize a Template's timeline (validate directors, index keyframes per
//     layer/group, precompute action frame thresholds)
//   - sample a director's animated values at a given playhead frame, applying
//     easing between adjacent keyframes
//   - detect when the playhead crosses an action's frame (cue firing)
//
// The engine channel page drives the playhead at a fixed tick rate (channel
// fps); the editor preview drives it with requestAnimationFrame. Both call
// `sampleAt(...)` per frame. Own implementation — no GSAP (§6.1).

import type {
  Timeline,
  TimelineDirector,
  TimelineKeyframe,
  TimelineAction,
  AnimatableValues,
  AnimatableProp,
} from './schema.js';
import { getEasing, makeBezierEasing, lerp } from './easing.js';

/**
 * A normalized timeline, ready for O(1)-ish sampling. Keyframes are indexed per
 * target id (layer or group) and sorted by frame.
 */
export interface NormalizedTimeline {
  /** directorId -> sorted keyframes that belong to that director */
  directors: Record<string, TimelineKeyframe[]>;
  directorList: TimelineDirector[];
  /** directorId -> actions, sorted by frame */
  actions: Record<string, TimelineAction[]>;
  fps: number;
  durationFrames: number;
}

/** Sort keyframes by frame. */
function sortKfs(kfs: TimelineKeyframe[]): TimelineKeyframe[] {
  return [...kfs].sort((a, b) => a.frame - b.frame);
}

/**
 * Build a NormalizedTimeline. A keyframe "belongs" to a director if the
 * director animates any target — we approximate by associating each keyframe
 * with the director(s) that animate the targets it touches. For the common case
 * (one director, many keyframes), all keyframes go to that director.
 *
 * Multi-director support: keyframes are partitioned by the director that
 * animates the target of each (layer/group) value inside them. A keyframe that
 * touches targets from several directors is duplicated into each.
 */
export function normalizeTimeline(tl: Timeline): NormalizedTimeline {
  // trackDirectors: targetId -> directorId. Build the reverse: directorId -> targets.
  const directorTargets: Record<string, Set<string>> = {};
  for (const [targetId, directorId] of Object.entries(tl.trackDirectors)) {
    if (!directorTargets[directorId]) directorTargets[directorId] = new Set();
    directorTargets[directorId].add(targetId);
  }

  const directors: Record<string, TimelineKeyframe[]> = {};
  for (const d of tl.directors) directors[d.id] = [];

  for (const kf of tl.keyframes) {
    const allTargets = new Set([...Object.keys(kf.layers), ...Object.keys(kf.groups)]);
    // If no explicit track mapping, default director 'default' owns it.
    let assigned = false;
    for (const target of allTargets) {
      const did = tl.trackDirectors[target];
      if (did && directors[did]) {
        directors[did].push(kf);
        assigned = true;
      }
    }
    if (!assigned && directors['default']) {
      directors['default'].push(kf);
    }
  }

  for (const did of Object.keys(directors)) directors[did] = sortKfs(directors[did]);

  const actions: Record<string, TimelineAction[]> = {};
  for (const a of tl.actions) {
    if (!actions[a.directorId]) actions[a.directorId] = [];
    actions[a.directorId].push(a);
  }
  for (const did of Object.keys(actions)) actions[did].sort((a, b) => a.frame - b.frame);

  return {
    directors,
    directorList: tl.directors,
    actions,
    fps: tl.fps,
    durationFrames: tl.durationFrames,
  };
}

/**
 * Compute the effective local frame for a director given a global playhead,
 * honoring offset, duration, loop and swing. Returns null if the director is
 * outside its active window (not yet started / finished on a bounded, non-loop).
 */
export function directorLocalFrame(d: TimelineDirector, globalFrame: number): number | null {
  const start = d.offsetFrames;
  const len = d.durationFrames;
  const rel = globalFrame - start;

  if (rel < 0) return null;
  if (rel > len) {
    if (d.loop) {
      const mod = rel % len;
      return d.swing ? (Math.floor(rel / len) % 2 === 1 ? len - mod : mod) : mod;
    }
    // Bounded, finished: clamp to last frame (so the final keyframe holds).
    return len;
  }
  return rel;
}

/** Interpolate animated values for one target across a sorted keyframe list. */
function sampleTarget(
  targetId: string,
  section: 'layers' | 'groups',
  kfs: TimelineKeyframe[],
  localFrame: number,
): AnimatableValues {
  if (kfs.length === 0) return {};

  // Collect only keyframes that actually animate this target, with their value
  // bags for it. (A keyframe entry for a target may be partial.)
  const relevant = kfs.filter((k) => {
    const bag = section === 'layers' ? k.layers : k.groups;
    return bag[targetId] !== undefined;
  });
  if (relevant.length === 0) return {};

  // Before first / after last keyframe: hold the boundary value.
  if (localFrame <= relevant[0].frame) return { ...relevant[0][section][targetId] };
  if (localFrame >= relevant[relevant.length - 1].frame) {
    return { ...relevant[relevant.length - 1][section][targetId] };
  }

  // Find the bracketing pair.
  let i = 0;
  while (i < relevant.length - 1 && relevant[i + 1].frame < localFrame) i++;
  const a = relevant[i];
  const b = relevant[i + 1];

  const aBag = a[section][targetId];
  const bBag = b[section][targetId];
  const span = b.frame - a.frame || 1;
  const rawT = (localFrame - a.frame) / span;
  const easing = a.bezier ? makeBezierEasing(a.bezier) : getEasing(a.easing);
  const eased = easing(rawT);

  const out: AnimatableValues = {};
  const props = new Set<AnimatableProp>([
    ...(Object.keys(aBag) as AnimatableProp[]),
    ...(Object.keys(bBag) as AnimatableProp[]),
  ]);
  for (const p of props) {
    const va = aBag[p];
    const vb = bBag[p];
    if (va === undefined) out[p] = vb;
    else if (vb === undefined) out[p] = va;
    else out[p] = lerp(va, vb, eased);
  }
  return out;
}

export interface DirectorSample {
  /** layerId -> animated transform/opacity overrides */
  layers: Record<string, AnimatableValues>;
  /** groupId -> animated transform overrides */
  groups: Record<string, AnimatableValues>;
  /** whether the director is active at this frame */
  active: boolean;
}

/** Result of sampling the full timeline at one frame. */
export interface TimelineSample {
  /** directorId -> per-director sample (active flag + its target values) */
  directors: Record<string, DirectorSample>;
  /** layerId -> merged animated values across all active directors */
  layers: Record<string, AnimatableValues>;
  /** groupId -> merged animated values across all active directors */
  groups: Record<string, AnimatableValues>;
}

/**
 * Sample the full animated state at a global frame: for each director, compute
 * its local frame (or skip if inactive), then interpolate each target's values.
 */
export function sampleAt(
  norm: NormalizedTimeline,
  globalFrame: number,
): TimelineSample {
  const perDirector: Record<string, DirectorSample> = {};
  const mergedLayers: Record<string, AnimatableValues> = {};
  const mergedGroups: Record<string, AnimatableValues> = {};

  for (const d of norm.directorList) {
    const local = directorLocalFrame(d, globalFrame);
    const active = local !== null;
    const ds: DirectorSample = { layers: {}, groups: {}, active };
    if (active) {
      const kfs = norm.directors[d.id] || [];
      const targets = norm.directorList.length === 1
        // Single-director common case: every target in trackDirectors.
        ? Object.keys(norm.directors[d.id].length ? collectTargets(kfs) : {})
        : Object.keys(targetSet(norm, d.id));
      for (const tid of targets) {
        // Try layers first, then groups (a target is one or the other).
        let vals = sampleTarget(tid, 'layers', kfs, local!);
        if (Object.keys(vals).length) {
          ds.layers[tid] = vals;
          mergedLayers[tid] = { ...(mergedLayers[tid] || {}), ...vals };
        } else {
          vals = sampleTarget(tid, 'groups', kfs, local!);
          if (Object.keys(vals).length) {
            ds.groups[tid] = vals;
            mergedGroups[tid] = { ...(mergedGroups[tid] || {}), ...vals };
          }
        }
      }
    }
    perDirector[d.id] = ds;
  }

  return { directors: perDirector, layers: mergedLayers, groups: mergedGroups };
}

function collectTargets(kfs: TimelineKeyframe[]): Record<string, true> {
  const set: Record<string, true> = {};
  for (const k of kfs) {
    for (const id of Object.keys(k.layers)) set[id] = true;
    for (const id of Object.keys(k.groups)) set[id] = true;
  }
  return set;
}

function targetSet(norm: NormalizedTimeline, directorId: string): Record<string, true> {
  // Targets owned by a director, from the normalized keyframes (already
  // partitioned by director in normalizeTimeline).
  return collectTargets(norm.directors[directorId] || []);
}

/**
 * Detect actions whose frame the playhead has crossed since the last sample.
 * Returns the actions in frame order. Call this with (prevFrame, curFrame) each
 * tick; prevFrame=null on the first tick.
 */
export function actionsCrossed(
  norm: NormalizedTimeline,
  directorId: string,
  prevFrame: number | null,
  curFrame: number,
): TimelineAction[] {
  const acts = norm.actions[directorId];
  if (!acts || acts.length === 0) return [];
  const out: TimelineAction[] = [];
  for (const a of acts) {
    const crossed = prevFrame === null
      ? a.frame <= curFrame
      : (prevFrame < a.frame && a.frame <= curFrame);
    if (crossed) out.push(a);
  }
  return out;
}
