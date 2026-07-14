// runtime/src/crawl.ts
// Crawl / ticker motion helpers (director-driven, no transform keyframes).

import type { CrawlAxisDir, CrawlKind, CrawlProps } from './schema.js';
import { applyTextTransform, splitCrawlLines, type TextStyle, type TextTransformMode } from './schema.js';

export function crawlLinesFromContent(
  raw: string,
  crawl: CrawlProps,
): string[] {
  const lines = splitCrawlLines(raw, crawl.maxTextLengthEnabled, crawl.maxTextLength);
  return lines.length > 0 ? lines : [''];
}

export function crawlDirectorLocalFrame(
  globalFrame: number,
  offsetFrames: number,
  durationFrames: number,
  loop: boolean,
): number {
  const dur = Math.max(1, durationFrames);
  const raw = globalFrame - offsetFrames;
  if (raw < 0) return 0;
  if (loop) return ((raw % dur) + dur) % dur;
  return Math.min(raw, dur);
}

/** Approximate content length along the crawl axis (px). */
export function approxLineSpanPx(
  line: string,
  crawl: CrawlProps,
  _boxW: number,
  boxH: number,
  fontSize: number,
): number {
  if (crawl.type === 'ticker') {
    // Include every character (spaces count). Floor at a small readable minimum.
    return Math.max(fontSize * 0.55, line.length * fontSize * 0.55);
  }
  return Math.max(fontSize * 1.2, boxH > 0 ? Math.min(boxH, fontSize * 1.2) : fontSize * 1.2);
}

export function approxSepPx(crawl: CrawlProps, boxH: number, fontSize: number): number {
  if (crawl.separatorMode === 'none') return 0;
  if (crawl.separatorMode === 'text') {
    // Spaces in separator text are significant.
    return Math.max(0, crawl.separatorText.length * fontSize * 0.55);
  }
  return Math.min(Math.max(16, boxH), 48);
}

function framesForTravelPx(px: number, speed: number, fps: number): number {
  const pxPerSec = Math.max(1, speed) * 60;
  return Math.max(1, Math.ceil((Math.abs(px) / pxPerSec) * Math.max(1, fps)));
}

export interface CrawlLinePhase {
  lineIndex: number;
  enterFrames: number;
  holdFrames: number;
  exitFrames: number;
  startFrame: number;
  enterEnd: number;
  holdEnd: number;
  endFrame: number;
}

export interface CrawlSchedule {
  mode: 'strip' | 'per-line';
  continuous: boolean;
  totalFrames: number;
  /** One content period in px (strip mode estimate). */
  periodPx: number;
  phases: CrawlLinePhase[];
}

function startOffset(dir: CrawlAxisDir, kind: CrawlKind, box: number, span: number): number {
  if (kind === 'ticker') {
    if (dir === 'left') return -span;
    if (dir === 'right') return box;
    return -span;
  }
  if (dir === 'up') return -span;
  if (dir === 'down') return box;
  return -span;
}

function endOffset(dir: CrawlAxisDir, kind: CrawlKind, box: number, span: number): number {
  if (kind === 'ticker') {
    if (dir === 'left') return -span;
    if (dir === 'right') return box;
    return box;
  }
  if (dir === 'up') return -span;
  if (dir === 'down') return box;
  return box;
}

function enterExitPx(
  crawl: CrawlProps,
  box: number,
  span: number,
  rest = 0,
): { enterPx: number; exitPx: number; startIn: number; endOut: number; rest: number } {
  const startIn = startOffset(crawl.directionIn, crawl.type, box, span);
  const endOut = endOffset(crawl.directionOut, crawl.type, box, span);
  if (crawl.directionIn === crawl.directionOut) {
    const enterPx = Math.abs(rest - startIn);
    return { enterPx, exitPx: enterPx, startIn, endOut: startIn, rest };
  }
  return {
    enterPx: Math.abs(rest - startIn),
    exitPx: Math.abs(endOut - rest),
    startIn,
    endOut,
    rest,
  };
}

/** Align applies for Carousel always, and for Ticker only when Pause>0. */
export function crawlAlignActive(crawl: CrawlProps): boolean {
  if (crawl.type === 'carousel') return true;
  return crawl.type === 'ticker' && Math.max(0, Math.round(crawl.pause)) > 0;
}

/**
 * Rest (fully-visible) offset along the scroll axis.
 * Only Ticker+Pause uses this for left/center/right; Carousel aligns via CSS cross-axis.
 */
export function crawlRestOffset(
  crawl: CrawlProps,
  align: 'left' | 'center' | 'right' | undefined,
  box: number,
  span: number,
): number {
  if (crawl.type !== 'ticker' || !crawlAlignActive(crawl)) return 0;
  if (align === 'center') return (box - span) / 2;
  if (align === 'right') return box - span;
  return 0;
}

export type CrawlAlign = 'left' | 'center' | 'right';

/** Build frame schedule matching paintCrawl / sampleCrawlMotion. */
export function buildCrawlSchedule(opts: {
  lines: string[];
  crawl: CrawlProps;
  boxWidth: number;
  boxHeight: number;
  fontSize: number;
  fps: number;
  align?: CrawlAlign;
}): CrawlSchedule {
  const { crawl, boxWidth, boxHeight, fontSize, fps } = opts;
  const items = opts.lines.length > 0 ? opts.lines : [''];
  const continuous = crawl.animationType === 'continuous';
  const pauseFrames = Math.max(0, Math.round(crawl.pause));
  const horizontal = crawl.type === 'ticker';
  const box = horizontal ? boxWidth : boxHeight;
  const sep = approxSepPx(crawl, boxHeight, fontSize);
  const align = opts.align ?? 'left';

  if (pauseFrames <= 0) {
    let periodPx = 0;
    for (let i = 0; i < items.length; i++) {
      periodPx += approxLineSpanPx(items[i]!, crawl, boxWidth, boxHeight, fontSize);
      if (i < items.length - 1) periodPx += sep;
    }
    // Batch: travel from off-screen in → off-screen out (period + box clearance).
    // Continuous: one seamless period (content length); paint duplicates the strip.
    const travelPx = continuous ? Math.max(1, periodPx + (sep > 0 ? sep : 0)) : Math.max(1, periodPx + box);
    const totalFrames = framesForTravelPx(travelPx, crawl.speed, fps);
    return {
      mode: 'strip',
      continuous,
      totalFrames,
      periodPx: Math.max(1, periodPx),
      phases: [],
    };
  }

  const phases: CrawlLinePhase[] = [];
  let cursor = 0;
  for (let i = 0; i < items.length; i++) {
    const span = approxLineSpanPx(items[i]!, crawl, boxWidth, boxHeight, fontSize);
    const rest = crawlRestOffset(crawl, align, box, span);
    const { enterPx, exitPx } = enterExitPx(crawl, box, span, rest);
    const enterFrames = framesForTravelPx(enterPx || box, crawl.speed, fps);
    const exitFrames = framesForTravelPx(exitPx || box, crawl.speed, fps);
    // Continuous: no hold after the last line so the first line follows immediately.
    const holdFrames = continuous && i === items.length - 1 ? 0 : pauseFrames;
    const startFrame = cursor;
    const enterEnd = startFrame + enterFrames;
    const holdEnd = enterEnd + holdFrames;
    const endFrame = holdEnd + exitFrames;
    phases.push({
      lineIndex: i,
      enterFrames,
      holdFrames,
      exitFrames,
      startFrame,
      enterEnd,
      holdEnd,
      endFrame,
    });
    cursor = endFrame;
  }
  return {
    mode: 'per-line',
    continuous,
    totalFrames: Math.max(1, cursor),
    periodPx: 0,
    phases,
  };
}

export function estimateCrawlDurationFrames(opts: {
  lines: string[];
  crawl: CrawlProps;
  boxWidth: number;
  boxHeight: number;
  fontSize: number;
  fps: number;
  align?: CrawlAlign;
}): number {
  return buildCrawlSchedule(opts).totalFrames;
}

export interface CrawlMotionSample {
  x: number;
  y: number;
  /** null = render full strip (optionally duplicated for continuous). */
  activeLineIndex: number | null;
  /** When strip+continuous, paint should duplicate content for a seamless loop. */
  duplicateStrip: boolean;
  /** Strip scroll period in px (measured preferred). */
  periodHintPx: number;
}

/**
 * Sample crawl track transform from director-local frame.
 * Pause>0 → one line at a time (enter → hold → exit).
 * Pause=0 → full strip; Continuous duplicates for seamless wrap.
 */
export function sampleCrawlMotion(opts: {
  localFrame: number;
  lines: string[];
  crawl: CrawlProps;
  boxW: number;
  boxH: number;
  fontSize: number;
  fps: number;
  /** Measured track span for the currently rendered content (one line or full strip). */
  measuredSpan: number;
  /** Measured period for one copy of the strip (continuous pause=0). */
  measuredPeriod?: number;
  align?: CrawlAlign;
}): CrawlMotionSample {
  const { localFrame, crawl, boxW, boxH, fontSize, fps } = opts;
  const lines = opts.lines.length > 0 ? opts.lines : [''];
  const align = opts.align ?? 'left';
  const schedule = buildCrawlSchedule({
    lines,
    crawl,
    boxWidth: boxW,
    boxHeight: boxH,
    fontSize,
    fps,
    align,
  });
  const horizontal = crawl.type === 'ticker';
  const box = horizontal ? boxW : boxH;
  const frame = Math.max(0, localFrame);

  if (schedule.mode === 'strip') {
    const period = Math.max(1, opts.measuredPeriod ?? schedule.periodPx);
    const span = Math.max(1, opts.measuredSpan);
    const dur = Math.max(1, schedule.totalFrames);
    const t = Math.min(1, frame / dur);

    if (schedule.continuous) {
      // Seamless marquee: shift by one period over the cycle.
      const along = -t * period;
      // Orient travel with out direction (primary travel sense).
      const signed = signedMarquee(along, crawl);
      if (horizontal) return {
        x: signed, y: 0, activeLineIndex: null, duplicateStrip: true, periodHintPx: period,
      };
      return {
        x: 0, y: signed, activeLineIndex: null, duplicateStrip: true, periodHintPx: period,
      };
    }

    const { startIn, endOut } = enterExitPx(crawl, box, span, 0);
    let along: number;
    if (crawl.directionIn === crawl.directionOut) {
      if (t <= 0.5) along = lerp(startIn, 0, t * 2);
      else along = lerp(0, startIn, (t - 0.5) * 2);
    } else {
      along = lerp(startIn, endOut, t);
    }
    if (horizontal) {
      return { x: along, y: 0, activeLineIndex: null, duplicateStrip: false, periodHintPx: period };
    }
    return { x: 0, y: along, activeLineIndex: null, duplicateStrip: false, periodHintPx: period };
  }

  // Per-line enter / hold / exit
  const phases = schedule.phases;
  let phase = phases[0]!;
  if (frame >= schedule.totalFrames) {
    phase = phases[phases.length - 1]!;
  } else {
    for (const p of phases) {
      if (frame >= p.startFrame && frame < p.endFrame) {
        phase = p;
        break;
      }
    }
  }

  const span = Math.max(1, opts.measuredSpan);
  // Carousel align is CSS cross-axis; ticker+pause rest position follows Align.
  const rest = horizontal ? crawlRestOffset(crawl, align, box, span) : 0;
  const { startIn, endOut } = enterExitPx(crawl, box, span, rest);
  let along = rest;
  if (frame < phase.enterEnd) {
    const u = phase.enterFrames <= 0 ? 1 : (frame - phase.startFrame) / phase.enterFrames;
    along = lerp(startIn, rest, clamp01(u));
  } else if (frame < phase.holdEnd) {
    along = rest;
  } else {
    const u = phase.exitFrames <= 0 ? 1 : (frame - phase.holdEnd) / phase.exitFrames;
    if (crawl.directionIn === crawl.directionOut) {
      along = lerp(rest, startIn, clamp01(u));
    } else {
      along = lerp(rest, endOut, clamp01(u));
    }
  }

  if (horizontal) {
    return {
      x: along, y: 0, activeLineIndex: phase.lineIndex, duplicateStrip: false, periodHintPx: span,
    };
  }
  return {
    x: 0, y: along, activeLineIndex: phase.lineIndex, duplicateStrip: false, periodHintPx: span,
  };
}

/** Keep crawlOffsetPx for simple progress-based callers (editor scrub fallback). */
export function crawlOffsetPx(opts: {
  progress: number;
  crawl: CrawlProps;
  boxW: number;
  boxH: number;
  contentSpan: number;
}): { x: number; y: number } {
  const { progress, crawl, boxW, boxH, contentSpan } = opts;
  const p = clamp01(progress);
  const horizontal = crawl.type === 'ticker';
  const box = horizontal ? boxW : boxH;
  const span = Math.max(1, contentSpan);
  const startIn = startOffset(crawl.directionIn, crawl.type, box, span);
  const endOut = endOffset(crawl.directionOut, crawl.type, box, span);
  let along: number;
  if (crawl.directionIn === crawl.directionOut) {
    if (p <= 0.5) along = lerp(startIn, 0, p * 2);
    else along = lerp(0, startIn, (p - 0.5) * 2);
  } else {
    along = lerp(startIn, endOut, p);
  }
  if (horizontal) return { x: along, y: 0 };
  return { x: 0, y: along };
}

function signedMarquee(alongNegPeriod: number, crawl: CrawlProps): number {
  // alongNegPeriod is -t*period (≤ 0). Map to travel sense from in/out.
  if (crawl.type === 'ticker') {
    const moveLeft = crawl.directionOut === 'left' || crawl.directionIn === 'right';
    return moveLeft ? alongNegPeriod : -alongNegPeriod;
  }
  const moveUp = crawl.directionOut === 'up' || crawl.directionIn === 'down';
  return moveUp ? alongNegPeriod : -alongNegPeriod;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t));
}

export function applyTextStyleToEl(
  el: HTMLElement,
  style: TextStyle,
  fill: string,
  opts?: { applyAlign?: boolean },
): void {
  el.style.fontFamily = `"${style.fontFamily}", system-ui, sans-serif`;
  el.style.fontSize = `${style.fontSize}px`;
  el.style.fontWeight = style.fontWeight;
  el.style.color = fill;
  // Align on the glyph itself only when the crawl mode uses it (Carousel / Ticker+pause).
  el.style.textAlign = opts?.applyAlign === false ? 'left' : style.align;
  el.style.lineHeight = String(style.lineHeight);
  el.style.letterSpacing = `${style.letterSpacing}px`;
  // `pre` preserves multiple spaces; nowrap would collapse them.
  el.style.whiteSpace = 'pre';
  el.style.webkitTextStroke = style.strokeWidth > 0
    ? `${style.strokeWidth}px ${style.strokeColor}`
    : '';
  const sx = typeof style.dropShadowOffsetX === 'number' ? style.dropShadowOffsetX : 0;
  const sy = typeof style.dropShadowOffsetY === 'number'
    ? style.dropShadowOffsetY
    : (typeof style.dropShadowDistance === 'number' ? style.dropShadowDistance : 1);
  el.style.textShadow = style.dropShadow
    ? `${sx}px ${sy}px ${style.dropShadowBlur}px ${style.dropShadowColor}`
    : '';
}

export function formatCrawlLine(
  line: string,
  transform: TextTransformMode | undefined,
): string {
  return applyTextTransform(line, transform);
}
