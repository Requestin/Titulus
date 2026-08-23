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

export type CrawlSchedule = {
  durationFrames: number;
  axis: 'x' | 'y';
  pxPerSec: number;
  pxPerFrame: number;
  lines: string[];
  segments: CrawlSegment[];
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

  if (pause === 0) {
    let strip = 0;
    for (let i = 0; i < lineSpans.length; i += 1) {
      strip += lineSpans[i] ?? 0;
      if (i < lineSpans.length - 1) strip += separatorSpan;
    }
    const travel = input.crawl.animationType === 'continuous' ? strip : strip + boxExtent;
    pushMove(segments, travel, pxPerFrame);
  } else {
    for (let i = 0; i < lines.length; i += 1) {
      const span = lineSpans[i] ?? 0;
      const rest = restOffset(input, axis, boxExtent, span, pause);
      const enter = Math.abs(hiddenOffset(input.crawl.directionIn, boxExtent, span) - rest);
      const exit = Math.abs(hiddenOffset(input.crawl.directionOut, boxExtent, span) - rest);
      const hold = input.crawl.animationType === 'continuous' && i === lines.length - 1 ? 0 : pause;
      pushMove(segments, enter, pxPerFrame);
      if (hold > 0) segments.push({ kind: 'hold', frames: hold });
      pushMove(segments, exit, pxPerFrame);
    }
  }

  const durationFrames = segments.reduce((sum, segment) => sum + segment.frames, 0);
  return { durationFrames, axis, pxPerSec, pxPerFrame, lines, segments };
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

function pushMove(segments: CrawlSegment[], distancePx: number, pxPerFrame: number): void {
  const distance = Math.max(0, distancePx);
  if (distance === 0) return;
  const frames = pxPerFrame > 0 ? Math.ceil(distance / pxPerFrame) : 0;
  if (frames > 0) segments.push({ kind: 'move', frames, distancePx: distance });
}
