import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Template } from '../src/schema.js';
import {
  CRAWL_PX_PER_SPEED_UNIT,
  crawlDuplicatesStrip,
  crawlPaintText,
  crawlPxPerSec,
  joinCrawlLines,
  sampleContinuousMarqueeOffset,
  scheduleCrawl,
  type CrawlScheduleInput,
} from '../src/crawlSchedule.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '../..');

function baseTicker(partial: Partial<CrawlScheduleInput> = {}): CrawlScheduleInput {
  return {
    content: 'First headline\nSecond headline',
    fps: 50,
    box: { width: 760, height: 96 },
    fontSize: 48,
    align: 'left',
    crawl: {
      type: 'ticker',
      directionIn: 'right',
      directionOut: 'left',
      speed: 5,
      pause: 0,
      separatorMode: 'text',
      separatorText: '  •  ',
      animationType: 'continuous',
      maxTextLengthEnabled: false,
      maxTextLength: 80,
    },
    ...partial,
    crawl: {
      type: 'ticker',
      directionIn: 'right',
      directionOut: 'left',
      speed: 5,
      pause: 0,
      separatorMode: 'text',
      separatorText: '  •  ',
      animationType: 'continuous',
      maxTextLengthEnabled: false,
      maxTextLength: 80,
      ...(partial.crawl ?? {}),
    },
  };
}

test('speed 1/5/10 is a multiple of 60 px/s', () => {
  assert.equal(CRAWL_PX_PER_SPEED_UNIT, 60);
  assert.equal(crawlPxPerSec(1), 60);
  assert.equal(crawlPxPerSec(5), 300);
  assert.equal(crawlPxPerSec(10), 600);
});

test('ticker stays on X and carousel stays on Y', () => {
  assert.equal(scheduleCrawl(baseTicker()).axis, 'x');
  assert.equal(scheduleCrawl(baseTicker({
    crawl: { ...baseTicker().crawl, type: 'carousel', directionIn: 'up', directionOut: 'down' },
  })).axis, 'y');
});

test('higher speed shortens duration and duration is counted in template fps', () => {
  const slow = scheduleCrawl(baseTicker({ crawl: { ...baseTicker().crawl, speed: 1 } }));
  const fast = scheduleCrawl(baseTicker({ crawl: { ...baseTicker().crawl, speed: 10 } }));
  assert.ok(slow.durationFrames > fast.durationFrames);
  assert.equal(slow.pxPerFrame, 60 / 50);
  assert.equal(fast.pxPerFrame, 600 / 50);
});

test('continuous pause=0 period is strip plus separator without box clearance', () => {
  const scheduled = scheduleCrawl(baseTicker());
  const strip = (14 * 48) + (5 * 48) + (15 * 48);
  assert.equal(scheduled.durationFrames, Math.ceil(strip / 6));
  assert.equal(scheduled.segments.length, 1);
  assert.equal(scheduled.segments[0]?.kind, 'move');
});

test('batch pause=0 travel includes box clearance', () => {
  const continuous = scheduleCrawl(baseTicker());
  const batch = scheduleCrawl(baseTicker({
    crawl: { ...baseTicker().crawl, animationType: 'batch' },
  }));
  assert.ok(batch.durationFrames > continuous.durationFrames);
  const strip = (14 * 48) + (5 * 48) + (15 * 48);
  assert.equal(batch.durationFrames, Math.ceil((strip + 760) / 6));
});

test('pause>0 is per-line enter/hold/exit and continuous zeros the last hold', () => {
  const batch = scheduleCrawl(baseTicker({
    crawl: { ...baseTicker().crawl, pause: 25, animationType: 'batch', separatorMode: 'none' },
  }));
  const continuous = scheduleCrawl(baseTicker({
    crawl: { ...baseTicker().crawl, pause: 25, animationType: 'continuous', separatorMode: 'none' },
  }));
  assert.ok(batch.segments.some((segment) => segment.kind === 'hold' && segment.frames === 25));
  const batchHolds = batch.segments.filter((segment) => segment.kind === 'hold');
  const continuousHolds = continuous.segments.filter((segment) => segment.kind === 'hold');
  assert.equal(batchHolds.length, 2);
  assert.equal(continuousHolds.length, 1);
});

test('ticker pause=0 ignores align; ticker pause>0 uses align for rest travel', () => {
  const left = scheduleCrawl(baseTicker({ align: 'left' }));
  const center = scheduleCrawl(baseTicker({ align: 'center' }));
  assert.equal(left.durationFrames, center.durationFrames);

  const pausedLeft = scheduleCrawl(baseTicker({
    align: 'left',
    crawl: {
      ...baseTicker().crawl,
      pause: 10,
      separatorMode: 'none',
      animationType: 'batch',
      directionIn: 'right',
      directionOut: 'right',
    },
  }));
  const pausedRight = scheduleCrawl(baseTicker({
    align: 'right',
    crawl: {
      ...baseTicker().crawl,
      pause: 10,
      separatorMode: 'none',
      animationType: 'batch',
      directionIn: 'right',
      directionOut: 'right',
    },
  }));
  assert.notEqual(pausedLeft.durationFrames, pausedRight.durationFrames);
});

test('maxTextLength cuts lines before measuring and shortens duration', () => {
  const full = scheduleCrawl(baseTicker());
  const cut = scheduleCrawl(baseTicker({
    crawl: { ...baseTicker().crawl, maxTextLengthEnabled: true, maxTextLength: 5 },
  }));
  assert.deepEqual(cut.lines, ['First', 'Secon']);
  assert.ok(cut.durationFrames < full.durationFrames);
});

test('identical input is byte-stable and does not read files', () => {
  const a = scheduleCrawl(baseTicker());
  const b = scheduleCrawl(baseTicker());
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('draft crawl fixtures produce a computed duration, not the authoring placeholder 250', () => {
  const ticker = JSON.parse(readFileSync(join(root, 'tests/fixtures/p21/draft/crawl-ticker.json'), 'utf8')) as Template;
  const carousel = JSON.parse(readFileSync(join(root, 'tests/fixtures/p21/draft/crawl-carousel.json'), 'utf8')) as Template;
  const tickerLayer = ticker.layers.find((layer) => layer.type === 'crawl');
  const carouselLayer = carousel.layers.find((layer) => layer.type === 'crawl');
  assert.ok(tickerLayer && tickerLayer.type === 'crawl');
  assert.ok(carouselLayer && carouselLayer.type === 'crawl');
  const tickerSchedule = scheduleCrawl({
    content: 'First headline\nSecond headline',
    fps: ticker.timeline.fps,
    box: { width: tickerLayer.transform.width, height: tickerLayer.transform.height },
    fontSize: tickerLayer.style.fontSize,
    align: tickerLayer.style.align,
    crawl: tickerLayer.crawl,
  });
  const carouselSchedule = scheduleCrawl({
    content: String(carouselLayer.content),
    fps: carousel.timeline.fps,
    box: { width: carouselLayer.transform.width, height: carouselLayer.transform.height },
    fontSize: carouselLayer.style.fontSize,
    align: carouselLayer.style.align,
    crawl: carouselLayer.crawl,
  });
  assert.notEqual(tickerSchedule.durationFrames, 250);
  assert.notEqual(carouselSchedule.durationFrames, 250);
  assert.equal(tickerSchedule.axis, 'x');
  assert.equal(carouselSchedule.axis, 'y');
  assert.ok(carouselSchedule.segments.some((segment) => segment.kind === 'hold' && segment.frames === 50));
});

test('backend and runtime scheduleCrawl stay on the same formulas', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const backend = require('../../backend/src/crawlSchedule.js') as {
    scheduleCrawl: typeof scheduleCrawl;
  };
  const input = {
    content: 'First item\nSecond item',
    fps: 50,
    box: { width: 800, height: 80 },
    fontSize: 48,
    align: 'left' as const,
    crawl: {
      type: 'ticker' as const,
      directionIn: 'right' as const,
      directionOut: 'left' as const,
      speed: 5,
      pause: 0,
      separatorMode: 'text' as const,
      separatorText: ' • ',
      separatorImage: '',
      animationType: 'continuous' as const,
      useFile: false,
      filePath: '',
      maxTextLengthEnabled: false,
      maxTextLength: 80,
    },
  };
  assert.deepEqual(backend.scheduleCrawl(input), scheduleCrawl(input));
});

test('continuous pause=0 paint duplicates the strip so the box can stay filled', () => {
  const crawl = baseTicker().crawl;
  assert.equal(crawlDuplicatesStrip(crawl), true);
  assert.equal(crawlDuplicatesStrip({ ...crawl, animationType: 'batch' }), false);
  assert.equal(crawlDuplicatesStrip({ ...crawl, pause: 12 }), false);
  const strip = joinCrawlLines('New crawl', { separatorMode: 'none', separatorText: '' });
  assert.equal(crawlPaintText(strip, { ...crawl, separatorMode: 'none' }), 'New crawlNew crawl');
  assert.equal(
    crawlPaintText(joinCrawlLines('A\nB', crawl), crawl),
    'A  •  B  •  A  •  B',
  );
});

test('continuous marquee at 0 and 1 is one measured period, not a box-clearance jump', () => {
  const crawl = baseTicker().crawl;
  assert.deepEqual(sampleContinuousMarqueeOffset(0, 400, 'x', crawl), { x: 0, y: 0 });
  assert.deepEqual(sampleContinuousMarqueeOffset(1, 400, 'x', crawl), { x: -400, y: 0 });
  assert.deepEqual(
    sampleContinuousMarqueeOffset(0.5, 400, 'x', { ...crawl, directionOut: 'right', directionIn: 'left' }),
    { x: 200, y: 0 },
  );
  assert.deepEqual(
    sampleContinuousMarqueeOffset(1, 96, 'y', { ...crawl, type: 'carousel', directionIn: 'up', directionOut: 'down' }),
    { x: 0, y: 96 },
  );
});
