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
  TimelineCue,
  TimelineCueDirection,
  TimelineCueItem,
  AnimatableValues,
  AnimatableProp,
  EasingType,
} from './schema.js';
import { getEasing, makeBezierEasing, lerp, type EasingFn } from './easing.js';

/**
 * One target's animation track entry, precompiled at normalize time. Holds the
 * keyframe's animated bag for this target plus the resolved easing function so
 * the per-frame hot path avoids re-resolving easing (and re-allocating bezier
 * solvers) every frame.
 */
interface CompiledTrackEntry {
  frame: number;
  bag: AnimatableValues;
  easing: EasingFn;
  propEasing?: Partial<Record<AnimatableProp, EasingFn>>;
}

/**
 * Per-target compiled tracks. A target is animated either as a layer or as a
 * group (never both); `isLayer` records which bag contributed so the sampler
 * can route the result without rescanning the keyframes each frame. Sorted by
 * `frame` at compile time.
 */
interface CompiledTargetTracks {
  entries: CompiledTrackEntry[];
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
  /** directorId -> compiled cues with fromEnd already resolved. */
  cues: Record<string, CompiledCue[]>;
  fps: number;
  durationFrames: number;
}

export interface CompiledCue {
  id: string;
  directorId: string;
  frame: number;
  fromEnd: boolean;
  name: string;
  items: TimelineCue['items'];
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
function hasPropertyOverrides(tl: Timeline): boolean {
  const map = tl.propertyTrackDirectors;
  if (!map) return false;
  return Object.values(map).some((bag) => bag && Object.keys(bag).length > 0);
}

function propertyDirector(tl: Timeline, targetId: string, prop: AnimatableProp): string {
  return tl.propertyTrackDirectors?.[targetId]?.[prop]
    ?? tl.trackDirectors[targetId]
    ?? 'default';
}

function splitBagByDirector(
  tl: Timeline,
  targetId: string,
  bag: AnimatableValues,
): Record<string, AnimatableValues> {
  const out: Record<string, AnimatableValues> = {};
  for (const [prop, value] of Object.entries(bag) as [AnimatableProp, number | undefined][]) {
    if (value === undefined) continue;
    const directorId = propertyDirector(tl, targetId, prop);
    (out[directorId] ??= {})[prop] = value;
  }
  return out;
}

function splitKeyframeByPropertyDirector(
  tl: Timeline,
  kf: TimelineKeyframe,
  rawByDirector: Record<string, TimelineKeyframe[]>,
): void {
  const layersByDirector: Record<string, Record<string, AnimatableValues>> = {};
  const groupsByDirector: Record<string, Record<string, AnimatableValues>> = {};
  for (const [targetId, bag] of Object.entries(kf.layers)) {
    for (const [directorId, sliced] of Object.entries(splitBagByDirector(tl, targetId, bag))) {
      (layersByDirector[directorId] ??= {})[targetId] = sliced;
    }
  }
  for (const [targetId, bag] of Object.entries(kf.groups)) {
    for (const [directorId, sliced] of Object.entries(splitBagByDirector(tl, targetId, bag))) {
      (groupsByDirector[directorId] ??= {})[targetId] = sliced;
    }
  }
  const directorIds = new Set([
    ...Object.keys(layersByDirector),
    ...Object.keys(groupsByDirector),
  ]);
  if (directorIds.size === 0 && rawByDirector['default']) {
    rawByDirector['default'].push(kf);
    return;
  }
  for (const directorId of directorIds) {
    if (!rawByDirector[directorId]) continue;
    rawByDirector[directorId].push({
      ...kf,
      layers: layersByDirector[directorId] ?? {},
      groups: groupsByDirector[directorId] ?? {},
    });
  }
}

function objectDirector(tl: Timeline, targetId: string): string {
  return tl.trackDirectors[targetId] ?? 'default';
}

/**
 * Partition one unscope keyframe into per-director slices so a shared frame
 * that carries both a default-owned group and an Update-owned layer does not
 * leak the layer bag into default (or the group bag into Update).
 */
function splitKeyframeByObjectDirector(
  tl: Timeline,
  kf: TimelineKeyframe,
  rawByDirector: Record<string, TimelineKeyframe[]>,
): void {
  const layersByDirector: Record<string, Record<string, AnimatableValues>> = {};
  const groupsByDirector: Record<string, Record<string, AnimatableValues>> = {};
  for (const [targetId, bag] of Object.entries(kf.layers)) {
    const directorId = objectDirector(tl, targetId);
    (layersByDirector[directorId] ??= {})[targetId] = bag;
  }
  for (const [targetId, bag] of Object.entries(kf.groups)) {
    const directorId = objectDirector(tl, targetId);
    (groupsByDirector[directorId] ??= {})[targetId] = bag;
  }
  const directorIds = new Set([
    ...Object.keys(layersByDirector),
    ...Object.keys(groupsByDirector),
  ]);
  if (directorIds.size === 0) {
    if (rawByDirector['default']) rawByDirector['default'].push(kf);
    return;
  }
  for (const directorId of directorIds) {
    if (!rawByDirector[directorId]) continue;
    rawByDirector[directorId].push({
      ...kf,
      layers: layersByDirector[directorId] ?? {},
      groups: groupsByDirector[directorId] ?? {},
    });
  }
}

export function normalizeTimeline(tl: Timeline): NormalizedTimeline {
  // trackDirectors: targetId -> directorId. Build the reverse: directorId -> targets.
  const directorTargets: Record<string, Set<string>> = {};
  for (const [targetId, directorId] of Object.entries(tl.trackDirectors)) {
    if (!directorTargets[directorId]) directorTargets[directorId] = new Set();
    directorTargets[directorId].add(targetId);
  }

  // Partition raw keyframes per director (same semantics as before).
  const rawByDirector: Record<string, TimelineKeyframe[]> = {};
  for (const d of tl.directors) rawByDirector[d.id] = [];

  const propertyOverrides = hasPropertyOverrides(tl);
  for (const kf of tl.keyframes) {
    if (kf.directorId) {
      if (rawByDirector[kf.directorId]) rawByDirector[kf.directorId].push(kf);
      continue;
    }
    if (propertyOverrides) {
      splitKeyframeByPropertyDirector(tl, kf, rawByDirector);
      continue;
    }
    splitKeyframeByObjectDirector(tl, kf, rawByDirector);
  }
  for (const did of Object.keys(rawByDirector)) {
    rawByDirector[did].sort((a, b) => a.frame - b.frame);
  }

  // Compile per-target tracks from the sorted keyframes. For each target we
  // gather every keyframe that touches it (with its layer OR group bag) plus
  // the resolved easing function, keeping the result sorted by frame. A target
  // is animated either as a layer or as a group, so we record which bag it came
  // from on the track to let the sampler route cheaply.
  const directors: Record<string, CompiledDirector> = {};
  for (const d of tl.directors) {
    const kfs = rawByDirector[d.id] ?? [];
    const tracks = new Map<string, CompiledTargetTracks>();
    for (const kf of kfs) {
      const easing = kf.bezier ? makeBezierEasing(kf.bezier) : getEasing(kf.easing);
      for (const [tid, bag] of Object.entries(kf.layers)) {
        pushEntry(tracks, tid, kf.frame, bag, easing, true, compilePropEasing(kf.layerEasings?.[tid]));
      }
      for (const [tid, bag] of Object.entries(kf.groups)) {
        pushEntry(tracks, tid, kf.frame, bag, easing, false, compilePropEasing(kf.groupEasings?.[tid]));
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
    cues: compileCues(tl),
    fps: tl.fps,
    durationFrames: tl.durationFrames,
  };
}

function compilePropEasing(
  map: Partial<Record<AnimatableProp, EasingType>> | undefined,
): Partial<Record<AnimatableProp, EasingFn>> | undefined {
  if (!map) return undefined;
  const out: Partial<Record<AnimatableProp, EasingFn>> = {};
  for (const [prop, type] of Object.entries(map) as [AnimatableProp, EasingType][]) {
    if (type) out[prop] = getEasing(type);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function pushEntry(
  tracks: Map<string, CompiledTargetTracks>,
  tid: string,
  frame: number,
  bag: AnimatableValues,
  easing: EasingFn,
  isLayer: boolean,
  propEasing?: Partial<Record<AnimatableProp, EasingFn>>,
): void {
  let t = tracks.get(tid);
  if (!t) { t = { entries: [], isLayer }; tracks.set(tid, t); }
  t.entries.push({ frame, bag, easing, propEasing });
}

/**
 * Compute the effective local frame for a director given a global playhead,
 * honoring offset, duration, loop and swing. Returns null if the director is
 * outside its active window (not yet started / finished on a bounded, non-loop).
 *
 * Swing ping-pongs local time (0→dur→0→…) and repeats for as long as the
 * director keeps receiving global time (air/actions can stop it later).
 */
export function directorLocalFrame(d: TimelineDirector, globalFrame: number): number | null {
  const start = d.offsetFrames;
  const len = Math.max(1, d.durationFrames);
  const rel = globalFrame - start;

  if (rel < 0) return null;

  if (d.swing) {
    const period = len * 2;
    const cycle = rel % period;
    if (cycle <= len) return cycle;
    return len - (cycle - len);
  }

  if (rel > len) {
    if (d.loop) return rel % len;
    return len;
  }
  return rel;
}

/**
 * Interpolate animated values for one target from its compiled track.
 *
 * Each property is sampled independently against the nearest keyframes that
 * actually define that property. Sparse dope-sheet bags (x keyed mid-span, y
 * only at ends) therefore animate simultaneously instead of snapping the
 * missing side to the adjacent bag's value.
 */
function sampleTargetTrack(
  track: CompiledTargetTracks,
  localFrame: number,
): AnimatableValues {
  const entries = track.entries;
  const n = entries.length;
  if (n === 0) return {};

  const props = new Set<AnimatableProp>();
  for (const entry of entries) {
    for (const key of Object.keys(entry.bag) as AnimatableProp[]) props.add(key);
  }

  const out: AnimatableValues = {};
  for (const prop of props) {
    const sampled = samplePropTrack(entries, prop, localFrame);
    if (sampled !== undefined) out[prop] = sampled;
  }
  return out;
}

/** Find prev/next keyframes that define `prop` and lerp (or hold) between them. */
function samplePropTrack(
  entries: CompiledTrackEntry[],
  prop: AnimatableProp,
  localFrame: number,
): number | undefined {
  let prev: CompiledTrackEntry | null = null;
  let next: CompiledTrackEntry | null = null;
  for (const entry of entries) {
    if (entry.bag[prop] === undefined) continue;
    if (entry.frame <= localFrame) prev = entry;
    if (entry.frame >= localFrame) {
      next = entry;
      break;
    }
  }
  if (!prev && !next) return undefined;
  if (!prev) return next!.bag[prop];
  if (!next || next === prev) return prev.bag[prop];

  const va = prev.bag[prop]!;
  const vb = next.bag[prop]!;
  const span = next.frame - prev.frame || 1;
  const rawT = (localFrame - prev.frame) / span;
  const ease = prev.propEasing?.[prop] ?? prev.easing;
  return lerp(va, vb, ease(rawT));
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
  const locals: Record<string, number | null> = {};
  for (const d of norm.directorList) {
    locals[d.id] = directorLocalFrame(d, globalFrame);
  }
  return sampleAtLocals(norm, locals);
}

/**
 * Sample with explicit per-director local frames (editor multi-playhead scrub).
 * `null` / missing means the director is inactive at this moment.
 */
export function sampleAtLocals(
  norm: NormalizedTimeline,
  locals: Record<string, number | null | undefined>,
): TimelineSample {
  const perDirector: Record<string, DirectorSample> = {};
  const mergedLayers: Record<string, AnimatableValues> = {};
  const mergedGroups: Record<string, AnimatableValues> = {};

  for (const d of norm.directorList) {
    const local = locals[d.id];
    const active = local !== null && local !== undefined;
    const ds: DirectorSample = { layers: {}, groups: {}, active };
    if (active) {
      const compiled = norm.directors[d.id];
      const tracks = compiled?.tracks;
      if (tracks) {
        for (const tid of compiled.targetIds) {
          const track = tracks.get(tid);
          if (!track) continue;
          const vals = sampleTargetTrack(track, local);
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

export function resolveCueFrame(
  cue: Pick<TimelineCue, 'frame' | 'fromEnd'>,
  directorDuration: number,
): number {
  const frame = Math.max(0, Math.round(cue.frame));
  if (!cue.fromEnd) return frame;
  return Math.max(0, Math.round(directorDuration) - frame);
}

function cueItemIsStateful(item: TimelineCueItem): boolean {
  return item.command !== '' && item.command !== 'tag';
}

export function timelineNeedsDirectorRuntime(tl: Timeline): boolean {
  for (const action of tl.actions) {
    if (action.command === 'startDirector' || action.command === 'stopDirector') return true;
  }
  for (const cue of tl.cues ?? []) {
    if (cue.items.some(cueItemIsStateful)) return true;
  }
  if (tl.keyframes.some((keyframe) => Boolean(keyframe.directorId))) return true;
  return false;
}

export function compileCues(tl: Timeline): Record<string, CompiledCue[]> {
  const durationByDirector = new Map(tl.directors.map((director) => [director.id, director.durationFrames]));
  const byDirector: Record<string, CompiledCue[]> = {};
  for (const director of tl.directors) byDirector[director.id] = [];
  for (const cue of tl.cues ?? []) {
    const duration = durationByDirector.get(cue.directorId) ?? tl.durationFrames;
    (byDirector[cue.directorId] ??= []).push({
      id: cue.id,
      directorId: cue.directorId,
      frame: resolveCueFrame(cue, duration),
      fromEnd: cue.fromEnd,
      name: cue.name,
      items: cue.items,
    });
  }
  for (const list of Object.values(byDirector)) {
    list.sort((left, right) => left.frame - right.frame || left.id.localeCompare(right.id));
  }
  return byDirector;
}

export function cuesCrossed(
  compiled: Record<string, CompiledCue[]>,
  directorId: string,
  prevFrame: number | null,
  curFrame: number,
  direction: TimelineCueDirection = 'normal',
): CompiledCue[] {
  const list = compiled[directorId] ?? [];
  if (list.length === 0) return [];
  const lower = prevFrame === null ? Number.NEGATIVE_INFINITY : prevFrame;
  let left = 0;
  let right = list.length;
  while (left < right) {
    const mid = (left + right) >> 1;
    if (list[mid]!.frame <= lower) left = mid + 1;
    else right = mid;
  }
  const out: CompiledCue[] = [];
  for (let index = left; index < list.length; index += 1) {
    const cue = list[index]!;
    if (cue.frame > curFrame) break;
    const items = cue.items.filter((item) => item.direction === 'both' || item.direction === direction);
    if (items.length === 0) continue;
    out.push(items.length === cue.items.length ? cue : { ...cue, items: items as CompiledCue['items'] });
  }
  return out;
}
