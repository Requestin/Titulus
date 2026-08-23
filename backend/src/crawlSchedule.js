export const CRAWL_PX_PER_SPEED_UNIT = 60;

export function crawlPxPerSec(speed) {
  return Math.max(0, speed) * CRAWL_PX_PER_SPEED_UNIT;
}

export function splitCrawlLines(content, maxTextLengthEnabled, maxTextLength) {
  const lines = String(content ?? '').split('\n');
  if (!maxTextLengthEnabled) return lines;
  const max = Math.max(1, Math.round(maxTextLength));
  return lines.map((line) => line.slice(0, max));
}

export function tickerLineSpan(text, fontSize) {
  return Math.max(0, String(text ?? '').length * fontSize);
}

export function scheduleCrawl(input) {
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
  const segments = [];
  const path = [];
  let frame = 0;
  const outNeg = input.crawl.directionOut === 'left' || input.crawl.directionOut === 'up';
  const inPos = input.crawl.directionIn === 'right' || input.crawl.directionIn === 'down';

  if (pause === 0) {
    let strip = 0;
    for (let i = 0; i < lineSpans.length; i += 1) {
      strip += lineSpans[i] ?? 0;
      if (i < lineSpans.length - 1) strip += separatorSpan;
    }
    const travel = strip + boxExtent;
    const start = inPos ? boxExtent : -strip;
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

function separatorExtent(input, axis, boxExtent) {
  if (input.crawl.separatorMode === 'none') return 0;
  if (input.crawl.separatorMode === 'text') {
    return axis === 'x'
      ? tickerLineSpan(input.crawl.separatorText, input.fontSize)
      : boxExtent;
  }
  return boxExtent;
}

function hiddenOffset(direction, boxExtent, lineSpan) {
  return direction === 'right' || direction === 'down' ? boxExtent : -lineSpan;
}

function restOffset(input, axis, boxExtent, lineSpan, pause) {
  if (axis === 'y' || pause <= 0) return 0;
  if (input.align === 'left') return 0;
  if (input.align === 'right') return boxExtent - lineSpan;
  return (boxExtent - lineSpan) / 2;
}

function pushMove(segments, distancePx, pxPerFrame) {
  const distance = Math.max(0, distancePx);
  if (distance === 0) return 0;
  const frames = pxPerFrame > 0 ? Math.ceil(distance / pxPerFrame) : 0;
  if (frames > 0) segments.push({ kind: 'move', frames, distancePx: distance });
  return frames;
}

export function syncCrawlProgressKeys(keyframes, layerId, durationFrames, createId) {
  const duration = Math.max(1, durationFrames);
  const list = keyframes ?? [];
  for (const key of list) {
    const bag = key.layers?.[layerId];
    if (!bag || !Object.prototype.hasOwnProperty.call(bag, 'crawlProgress')) continue;
    delete bag.crawlProgress;
    if (Object.keys(bag).length === 0) delete key.layers[layerId];
  }
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const key = list[i];
    const emptyLayers = Object.keys(key.layers || {}).length === 0;
    const emptyGroups = Object.keys(key.groups || {}).length === 0;
    if (emptyLayers && emptyGroups && key.frame !== 0 && key.frame !== duration) {
      list.splice(i, 1);
    }
  }
  let start = list.find((key) => key.frame === 0);
  if (!start) {
    start = { id: createId(), frame: 0, layers: {}, groups: {}, easing: 'linear' };
    list.push(start);
  }
  start.layers = start.layers || {};
  start.layers[layerId] = { ...start.layers[layerId], crawlProgress: 0 };
  let end = list.find((key) => key.frame === duration);
  if (!end) {
    end = { id: createId(), frame: duration, layers: {}, groups: {}, easing: 'linear' };
    list.push(end);
  }
  end.layers = end.layers || {};
  end.layers[layerId] = { ...end.layers[layerId], crawlProgress: 1 };
}
