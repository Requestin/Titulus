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
import { timelineTrackKey } from './schema.js';
import { getEasing, makeBezierEasing, lerp, type EasingFn } from './easing.js';

/**
 * One target's animation track entry, precompiled at normalize time. Holds the
 * keyframe's animated bag for this target plus the resolved easing function so
 * the per-frame hot path avoids re-resolving easing (and re-allocating bezier
 * solvers) every frame.
 */
interface CompiledTrackEntry {
  frame: number;
  value: number;
  easing: EasingFn;
}

/**
 * Per-target compiled tracks — one independent entry list per animated property.
 * Props on the same layer MUST NOT share a single keyframe timeline; otherwise
 * a keyframe for opacity at frame 100 and x at frame 0 would make opacity tween
 * over 1 frame (0→100 bracket polluted by x-only entries).
 */
interface CompiledTargetTracks {
  props: Map<AnimatableProp, CompiledTrackEntry[]>;
  isLayer: boolean;
}

/** Precompiled per-director index: targetId -> sorted compiled track. */
interface CompiledDirector {
  /** Sorted keyframes that belong to this director (kept for actionsCrossed, etc.). */
  keyframes: TimelineKeyframe[];
  /** targetId -> compiled track (layers OR groups, deduced at compile). */
  tracks: Map<string, CompiledTargetTracks>;
  /** Target ids owned by this director (set built once at compile). */
  targetIds: string[];
}

/**
 * A normalized timeline, ready for O(1)-ish sampling. Per-target keyframe lists
 * are precompiled into CompiledDirector.tracks (sorted by frame, with easing
 * resolved once), so per-frame sampling is a Map lookup + binary search instead
 * of a full filter+sort over every keyframe.
 */
export interface NormalizedTimeline {
  /** directorId -> compiled director (per-target sorted tracks + eased entries). */
  directors: Record<string, CompiledDirector>;
  directorList: TimelineDirector[];
  /** directorId -> actions, sorted by frame */
  actions: Record<string, TimelineAction[]>;
  fps: number;
  durationFrames: number;
}

/** Resolve which director owns a single animated property track. */
export function resolveTrackDirector(
  tl: Timeline,
  target: { kind: 'layer' | 'group'; id: string },
  prop: AnimatableProp,
): string | undefined {
  const key = timelineTrackKey(target, prop);
  if (tl.trackDirectors[key]) return tl.trackDirectors[key];
  // Legacy: bare target id applies to all props on that target.
  if (tl.trackDirectors[target.id]) return tl.trackDirectors[target.id];
  return undefined;
}

function kfTouchesDirector(tl: Timeline, kf: TimelineKeyframe, directorId: string): boolean {
  for (const [tid, bag] of Object.entries(kf.layers)) {
    for (const prop of Object.keys(bag) as AnimatableProp[]) {
      const did = resolveTrackDirector(tl, { kind: 'layer', id: tid }, prop);
      if (did === directorId) return true;
    }
  }
  for (const [tid, bag] of Object.entries(kf.groups)) {
    for (const prop of Object.keys(bag) as AnimatableProp[]) {
      const did = resolveTrackDirector(tl, { kind: 'group', id: tid }, prop);
      if (did === directorId) return true;
    }
  }
  return false;
}

function filterBagForDirector(
  tl: Timeline,
  directorId: string,
  target: { kind: 'layer' | 'group'; id: string },
  bag: AnimatableValues,
): AnimatableValues {
  const out: AnimatableValues = {};
  for (const prop of Object.keys(bag) as AnimatableProp[]) {
    const did = resolveTrackDirector(tl, target, prop);
    if (did === directorId) out[prop] = bag[prop]!;
  }
  return out;
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
  const defaultDirectorId = tl.directors[0]?.id ?? 'default';

  const rawByDirector: Record<string, TimelineKeyframe[]> = {};
  for (const d of tl.directors) rawByDirector[d.id] = [];

  for (const kf of tl.keyframes) {
    let assigned = false;
    for (const d of tl.directors) {
      if (kfTouchesDirector(tl, kf, d.id)) {
        rawByDirector[d.id].push(kf);
        assigned = true;
      }
    }
    if (!assigned && rawByDirector[defaultDirectorId]) {
      rawByDirector[defaultDirectorId].push(kf);
    }
  }
  for (const did of Object.keys(rawByDirector)) {
    rawByDirector[did].sort((a, b) => a.frame - b.frame);
  }

  const directors: Record<string, CompiledDirector> = {};
  for (const d of tl.directors) {
    const kfs = rawByDirector[d.id] ?? [];
    const tracks = new Map<string, CompiledTargetTracks>();
    for (const kf of kfs) {
      const easing = kf.bezier ? makeBezierEasing(kf.bezier) : getEasing(kf.easing);
      for (const [tid, bag] of Object.entries(kf.layers)) {
        const filtered = filterBagForDirector(tl, d.id, { kind: 'layer', id: tid }, bag);
        for (const prop of Object.keys(filtered) as AnimatableProp[]) {
          pushPropEntry(tracks, tid, prop, kf.frame, filtered[prop]!, easing, true);
        }
      }
      for (const [tid, bag] of Object.entries(kf.groups)) {
        const filtered = filterBagForDirector(tl, d.id, { kind: 'group', id: tid }, bag);
        for (const prop of Object.keys(filtered) as AnimatableProp[]) {
          pushPropEntry(tracks, tid, prop, kf.frame, filtered[prop]!, easing, false);
        }
      }
    }
    for (const track of tracks.values()) {
      for (const entries of track.props.values()) {
        entries.sort((a, b) => a.frame - b.frame);
      }
    }
    directors[d.id] = {
      keyframes: kfs,
      tracks,
      targetIds: [...tracks.keys()],
    };
  }

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

function pushPropEntry(
  tracks: Map<string, CompiledTargetTracks>,
  tid: string,
  prop: AnimatableProp,
  frame: number,
  value: number,
  easing: EasingFn,
  isLayer: boolean,
): void {
  let t = tracks.get(tid);
  if (!t) {
    t = { props: new Map(), isLayer };
    tracks.set(tid, t);
  }
  let entries = t.props.get(prop);
  if (!entries) {
    entries = [];
    t.props.set(prop, entries);
  }
  const existing = entries.find((e) => e.frame === frame);
  if (existing) {
    existing.value = value;
    return;
  }
  entries.push({ frame, value, easing });
}

/** Sample one director at an explicit local frame (editor per-director playheads). */
function sampleDirectorAtLocal(
  norm: NormalizedTimeline,
  directorId: string,
  localFrame: number,
): DirectorSample {
  const compiled = norm.directors[directorId];
  const ds: DirectorSample = { layers: {}, groups: {}, active: true };
  if (!compiled) return ds;
  for (const tid of compiled.targetIds) {
    const track = compiled.tracks.get(tid);
    if (!track) continue;
    const vals = sampleTargetTrack(track, localFrame);
    if (Object.keys(vals).length === 0) continue;
    if (track.isLayer) ds.layers[tid] = vals;
    else ds.groups[tid] = vals;
  }
  return ds;
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

/** Interpolate one property from its own compiled entry list. */
function samplePropTrack(entries: CompiledTrackEntry[], localFrame: number): number | undefined {
  const n = entries.length;
  if (n === 0) return undefined;

  if (localFrame <= entries[0]!.frame) return entries[0]!.value;
  if (localFrame >= entries[n - 1]!.frame) return entries[n - 1]!.value;

  let lo = 0;
  let hi = n - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (entries[mid]!.frame <= localFrame) lo = mid;
    else hi = mid;
  }
  const a = entries[lo]!;
  const b = entries[hi]!;
  const span = b.frame - a.frame || 1;
  const rawT = (localFrame - a.frame) / span;
  return lerp(a.value, b.value, a.easing(rawT));
}

/** Interpolate all animated properties for one target (independent per prop). */
function sampleTargetTrack(
  track: CompiledTargetTracks,
  localFrame: number,
): AnimatableValues {
  const out: AnimatableValues = {};
  for (const [prop, entries] of track.props) {
    const v = samplePropTrack(entries, localFrame);
    if (v !== undefined) out[prop] = v;
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
 * its local frame (or skip if inactive), then interpolate each target's values
 * from its precompiled track.
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
      const compiled = norm.directors[d.id];
      const tracks = compiled?.tracks;
      if (tracks) {
        for (const tid of compiled.targetIds) {
          const track = tracks.get(tid);
          if (!track) continue;
          const vals = sampleTargetTrack(track, local!);
          if (Object.keys(vals).length === 0) continue;
          if (track.isLayer) {
            ds.layers[tid] = vals;
            mergedLayers[tid] = { ...(mergedLayers[tid] || {}), ...vals };
          } else {
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

/**
 * Sample with independent local playheads per director (Action runtime / editor).
 * Directors with no compiled tracks are skipped (dormant Update costs ~0).
 */
export function sampleAtDirectorLocals(
  norm: NormalizedTimeline,
  localFrames: Record<string, number>,
): TimelineSample {
  const perDirector: Record<string, DirectorSample> = {};
  const mergedLayers: Record<string, AnimatableValues> = {};
  const mergedGroups: Record<string, AnimatableValues> = {};

  for (const d of norm.directorList) {
    const compiled = norm.directors[d.id];
    if (!compiled || compiled.targetIds.length === 0) {
      perDirector[d.id] = { layers: {}, groups: {}, active: false };
      continue;
    }
    // Keep fractional local frames in browser/editor previews. Action crossing
    // remains integer-driven; interpolation may follow the display refresh rate.
    const local = Math.max(0, Math.min(d.durationFrames, localFrames[d.id] ?? 0));
    const ds = sampleDirectorAtLocal(norm, d.id, local);
    perDirector[d.id] = ds;
    for (const [tid, vals] of Object.entries(ds.layers)) {
      mergedLayers[tid] = { ...(mergedLayers[tid] || {}), ...vals };
    }
    for (const [tid, vals] of Object.entries(ds.groups)) {
      mergedGroups[tid] = { ...(mergedGroups[tid] || {}), ...vals };
    }
  }

  return { directors: perDirector, layers: mergedLayers, groups: mergedGroups };
}

/** Advance a director's relative elapsed time by delta frames; returns new rel and whether playback finished. */
export function advanceDirectorRel(
  d: TimelineDirector,
  rel: number,
  delta: number,
): { rel: number; done: boolean } {
  const len = Math.max(1, d.durationFrames);
  const next = rel + delta;
  if (!d.loop && next >= len) return { rel: len, done: true };
  return { rel: next, done: false };
}

/** Map accumulated relative time to display local frame (loop/swing aware). */
export function directorRelToLocal(d: TimelineDirector, rel: number): number {
  const local = directorLocalFrame(d, d.offsetFrames + rel);
  return local ?? d.durationFrames;
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
