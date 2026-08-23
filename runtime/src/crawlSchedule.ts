export const CRAWL_PX_PER_SPEED_UNIT = 60;

export type CrawlScheduleAlign = 'left' | 'center' | 'right';

export type CrawlScheduleInput = {
  content: string;
  fps: number;
  box: { width: number; height: number };
  fontSize: number;
  align: CrawlScheduleAlign;
  crawl: {
    type: 'ticker' | 'carousel';
    directionIn: 'left' | 'right' | 'up' | 'down';
    directionOut: 'left' | 'right' | 'up' | 'down';
    speed: number;
    pause: number;
    separatorMode: 'none' | 'text' | 'image';
    separatorText: string;
    animationType: 'batch' | 'continuous';
    maxTextLengthEnabled: boolean;
    maxTextLength: number;
  };
};

export type CrawlSegment =
  | { kind: 'move'; frames: number; distancePx: number }
  | { kind: 'hold'; frames: number };

export type CrawlPathPoint = { frame: number; offset: number };

export type CrawlSchedule = {
  durationFrames: number;
  axis: 'x' | 'y';
  pxPerSec: number;
  pxPerFrame: number;
  lines: string[];
  segments: CrawlSegment[];
  path: CrawlPathPoint[];
};

export function crawlPxPerSec(speed: number): number {
  return Math.max(0, speed) * CRAWL_PX_PER_SPEED_UNIT;
}

export function splitCrawlLines(
  content: string,
  maxTextLengthEnabled: boolean,
  maxTextLength: number,
): string[] {
  const lines = content.split('\n');
  if (!maxTextLengthEnabled) return lines;
  const max = Math.max(1, Math.round(maxTextLength));
  return lines.map((line) => line.slice(0, max));
}

export function tickerLineSpan(text: string, fontSize: number): number {
  return Math.max(0, text.length * fontSize);
}

export function crawlDuplicatesStrip(
  crawl: Pick<CrawlScheduleInput['crawl'], 'animationType' | 'pause'>,
): boolean {
  return crawl.animationType === 'continuous' && Math.max(0, crawl.pause) <= 0;
}

export function joinCrawlLines(
  text: string,
  crawl: Pick<CrawlScheduleInput['crawl'], 'separatorMode' | 'separatorText'>,
): string {
  if (crawl.separatorMode === 'text') return text.split('\n').join(crawl.separatorText);
  return text;
}

export function crawlPaintText(
  strip: string,
  crawl: Pick<CrawlScheduleInput['crawl'], 'animationType' | 'pause' | 'separatorMode' | 'separatorText' | 'type'>,
): string {
  if (!crawlDuplicatesStrip(crawl) || strip.length === 0) return strip;
  const glue = crawl.separatorMode === 'text'
    ? crawl.separatorText
    : (crawl.type === 'carousel' ? '\n' : '');
  return `${strip}${glue}${strip}`;
}

export function continuousMarqueePeriod(copyPx: number, boxExtent: number): number {
  return Math.max(1, copyPx, boxExtent);
}

export function sampleContinuousMarqueeOffset(
  progress: number,
  copyPx: number,
  boxExtent: number,
  axis: 'x' | 'y',
  crawl: Pick<CrawlScheduleInput['crawl'], 'type' | 'directionIn' | 'directionOut'>,
): { x: number; y: number } {
  const p = Math.min(1, Math.max(0, progress));
  const box = Math.max(0, boxExtent);
  const period = continuousMarqueePeriod(copyPx, box);
  const inPos = crawl.directionIn === 'right' || crawl.directionIn === 'down';
  const outNeg = crawl.directionOut === 'left' || crawl.directionOut === 'up';
  const start = inPos ? box : 0;
  const end = outNeg ? start - period : start + period;
  const along = start + p * (end - start);
  return axis === 'x' ? { x: along, y: 0 } : { x: 0, y: along };
}

export type CrawlProgressKeyframe = {
  id: string;
  frame: number;
  layers: Record<string, Record<string, unknown>>;
  groups: Record<string, unknown>;
  easing: string;
};

export function syncCrawlProgressKeys<T extends CrawlProgressKeyframe>(
  keyframes: T[],
  layerId: string,
  durationFrames: number,
  createId: () => string,
): void {
  const duration = Math.max(1, durationFrames);
  for (const key of keyframes) {
    const bag = key.layers[layerId];
    if (!bag || !Object.prototype.hasOwnProperty.call(bag, 'crawlProgress')) continue;
    delete bag.crawlProgress;
    if (Object.keys(bag).length === 0) delete key.layers[layerId];
  }
  for (let i = keyframes.length - 1; i >= 0; i -= 1) {
    const key = keyframes[i]!;
    const emptyLayers = Object.keys(key.layers).length === 0;
    const emptyGroups = Object.keys(key.groups ?? {}).length === 0;
    if (emptyLayers && emptyGroups && key.frame !== 0 && key.frame !== duration) {
      keyframes.splice(i, 1);
    }
  }
  let start = keyframes.find((key) => key.frame === 0);
  if (!start) {
    start = {
      id: createId(),
      frame: 0,
      layers: {},
      groups: {},
      easing: 'linear',
    } as T;
    keyframes.push(start);
  }
  start.layers[layerId] = { ...start.layers[layerId], crawlProgress: 0 };
  let end = keyframes.find((key) => key.frame === duration);
  if (!end) {
    end = {
      id: createId(),
      frame: duration,
      layers: {},
      groups: {},
      easing: 'linear',
    } as T;
    keyframes.push(end);
  }
  end.layers[layerId] = { ...end.layers[layerId], crawlProgress: 1 };
}

export function scheduleCrawl(input: CrawlScheduleInput): CrawlSchedule {
  const fps = Math.max(1, input.fps);
  const pxPerSec = crawlPxPerSec(input.crawl.speed);
  const pxPerFrame = pxPerSec / fps;
  const axis = input.crawl.type === 'carousel' ? 'y' : 'x';
  const boxExtent = axis === 'x' ? input.box.width : input.box.height;
  const lines = splitCrawlLines(
    input.content,
    input.crawl.maxTextLengthEnabled,
    input.crawl.maxTextLength,
  );
  const lineSpans = lines.map((line) => (
    axis === 'x' ? tickerLineSpan(line, input.fontSize) : boxExtent
  ));
  const separatorSpan = separatorExtent(input, axis, boxExtent);
  const pause = Math.max(0, Math.round(input.crawl.pause));
  const segments: CrawlSegment[] = [];
  const path: CrawlPathPoint[] = [];
  let frame = 0;
  const outNeg = input.crawl.directionOut === 'left' || input.crawl.directionOut === 'up';
  const inPos = input.crawl.directionIn === 'right' || input.crawl.directionIn === 'down';

  if (pause === 0) {
    let strip = 0;
    for (let i = 0; i < lineSpans.length; i += 1) {
      strip += lineSpans[i] ?? 0;
      if (i < lineSpans.length - 1) strip += separatorSpan;
    }
    const travel = input.crawl.animationType === 'continuous'
      ? Math.max(strip, boxExtent)
      : strip + boxExtent;
    const start = input.crawl.animationType === 'continuous'
      ? (inPos ? boxExtent : 0)
      : (inPos ? boxExtent : -strip);
    const end = start + (outNeg ? -travel : travel);
    const moveFrames = pushMove(segments, travel, pxPerFrame);
    path.push({ frame, offset: start });
    frame += moveFrames;
    path.push({ frame, offset: end });
  } else {
    for (let i = 0; i < lines.length; i += 1) {
      const span = lineSpans[i] ?? 0;
      const rest = restOffset(input, axis, boxExtent, span, pause);
      const hiddenIn = hiddenOffset(input.crawl.directionIn, boxExtent, span);
      const hiddenOut = hiddenOffset(input.crawl.directionOut, boxExtent, span);
      const hold = input.crawl.animationType === 'continuous' && i === lines.length - 1 ? 0 : pause;
      path.push({ frame, offset: hiddenIn });
      const enterFrames = pushMove(segments, Math.abs(hiddenIn - rest), pxPerFrame);
      frame += enterFrames;
      path.push({ frame, offset: rest });
      if (hold > 0) {
        segments.push({ kind: 'hold', frames: hold });
        frame += hold;
        path.push({ frame, offset: rest });
      }
      const exitFrames = pushMove(segments, Math.abs(hiddenOut - rest), pxPerFrame);
      frame += exitFrames;
      path.push({ frame, offset: hiddenOut });
    }
  }

  const durationFrames = segments.reduce((sum, segment) => sum + segment.frames, 0);
  if (path.length === 0) path.push({ frame: 0, offset: 0 });
  return { durationFrames, axis, pxPerSec, pxPerFrame, lines, segments, path };
}

export function sampleCrawlOffset(
  input: CrawlScheduleInput,
  progress: number,
): { x: number; y: number } {
  const schedule = typeof progress === 'number' ? scheduleCrawl(input) : scheduleCrawl(input);
  const p = Math.min(1, Math.max(0, progress));
  const frame = p * schedule.durationFrames;
  const offset = interpolatePath(schedule.path, frame);
  return schedule.axis === 'x' ? { x: offset, y: 0 } : { x: 0, y: offset };
}

function interpolatePath(path: CrawlPathPoint[], frame: number): number {
  if (path.length === 0) return 0;
  if (frame <= (path[0]?.frame ?? 0)) return path[0]?.offset ?? 0;
  for (let i = 1; i < path.length; i += 1) {
    const prev = path[i - 1]!;
    const next = path[i]!;
    if (frame <= next.frame) {
      const span = next.frame - prev.frame;
      if (span <= 0) return next.offset;
      const t = (frame - prev.frame) / span;
      return prev.offset + (next.offset - prev.offset) * t;
    }
  }
  return path[path.length - 1]?.offset ?? 0;
}

function separatorExtent(input: CrawlScheduleInput, axis: 'x' | 'y', boxExtent: number): number {
  if (input.crawl.separatorMode === 'none') return 0;
  if (input.crawl.separatorMode === 'text') {
    return axis === 'x'
      ? tickerLineSpan(input.crawl.separatorText, input.fontSize)
      : boxExtent;
  }
  return boxExtent;
}

function hiddenOffset(
  direction: CrawlScheduleInput['crawl']['directionIn'],
  boxExtent: number,
  lineSpan: number,
): number {
  return direction === 'right' || direction === 'down' ? boxExtent : -lineSpan;
}

function restOffset(
  input: CrawlScheduleInput,
  axis: 'x' | 'y',
  boxExtent: number,
  lineSpan: number,
  pause: number,
): number {
  if (axis === 'y' || pause <= 0) return 0;
  if (input.align === 'left') return 0;
  if (input.align === 'right') return boxExtent - lineSpan;
  return (boxExtent - lineSpan) / 2;
}

function pushMove(segments: CrawlSegment[], distancePx: number, pxPerFrame: number): number {
  const distance = Math.max(0, distancePx);
  if (distance === 0) return 0;
  const frames = pxPerFrame > 0 ? Math.ceil(distance / pxPerFrame) : 0;
  if (frames > 0) segments.push({ kind: 'move', frames, distancePx: distance });
  return frames;
}
