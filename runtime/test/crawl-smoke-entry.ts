// runtime/test/crawl-smoke-entry.ts
// Assertions for crawl defaults / pause schedule / whitespace.
// Bundled by crawl-smoke.mjs via local esbuild (offline).

import {
  approxSepPx,
  buildCrawlSchedule,
  crawlAlignActive,
  crawlRestOffset,
  sampleCrawlMotion,
} from '../src/crawl.ts';
import { defaultCrawlProps, splitCrawlLines } from '../src/schema.ts';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const lines = ['AAA', 'BBB', 'CCC'];
const carouselPause = {
  ...defaultCrawlProps(),
  type: 'carousel' as const,
  directionIn: 'up' as const,
  directionOut: 'down' as const,
  pause: 25,
  speed: 5,
  animationType: 'batch' as const,
};

const sch = buildCrawlSchedule({
  lines,
  crawl: carouselPause,
  boxWidth: 400,
  boxHeight: 80,
  fontSize: 48,
  fps: 50,
});
assert(sch.mode === 'per-line', 'pause>0 must use per-line mode');
assert(sch.phases.length === 3, 'expected 3 line phases');
assert(sch.phases.every((p) => p.holdFrames === 25), 'batch: every line holds pause frames');
assert(
  sch.totalFrames === sch.phases[sch.phases.length - 1]!.endFrame,
  'totalFrames must match last phase end',
);

const cont = { ...carouselPause, animationType: 'continuous' as const };
const schCont = buildCrawlSchedule({
  lines,
  crawl: cont,
  boxWidth: 400,
  boxHeight: 80,
  fontSize: 48,
  fps: 50,
});
assert(schCont.phases[0]!.holdFrames === 25, 'continuous: first line keeps pause');
assert(schCont.phases[1]!.holdFrames === 25, 'continuous: middle line keeps pause');
assert(schCont.phases[2]!.holdFrames === 0, 'continuous: last line has no pause before wrap');

const defs = defaultCrawlProps();
assert(defs.type === 'ticker', 'default type must be ticker');
assert(defs.directionIn === 'right', 'default in must be right');
assert(defs.directionOut === 'left', 'default out must be left');

const spaced = splitCrawlLines('a  b\nc   d', false, 80);
assert(spaced[0] === 'a  b', 'content spaces must be preserved');
assert(spaced[1] === 'c   d', 'content spaces must be preserved on line 2');

const sepCrawl = { ...defaultCrawlProps(), separatorMode: 'text' as const, separatorText: ' -  - ' };
assert(approxSepPx(sepCrawl, 80, 48) > 0, 'separator spaces must count toward width');

const p = sch.phases[0]!;
const midHold = sampleCrawlMotion({
  localFrame: p.enterEnd + Math.floor(p.holdFrames / 2),
  lines,
  crawl: carouselPause,
  boxW: 400,
  boxH: 80,
  fontSize: 48,
  fps: 50,
  measuredSpan: 60,
});
assert(midHold.activeLineIndex === 0, 'hold phase stays on first line');
assert(midHold.y === 0, 'hold phase must keep fully-visible offset (y=0)');

const midEnter = sampleCrawlMotion({
  localFrame: p.startFrame + Math.floor(p.enterFrames / 2),
  lines,
  crawl: carouselPause,
  boxW: 400,
  boxH: 80,
  fontSize: 48,
  fps: 50,
  measuredSpan: 60,
});
assert(midEnter.activeLineIndex === 0, 'enter phase on first line');
assert(midEnter.y !== 0, 'enter phase must still be moving');

assert(crawlAlignActive(carouselPause) === true, 'carousel uses align');
assert(crawlAlignActive(defaultCrawlProps()) === false, 'ticker pause=0 ignores align');
const tickerPause = { ...defaultCrawlProps(), pause: 10 };
assert(crawlAlignActive(tickerPause) === true, 'ticker pause>0 uses align');

const restCenter = crawlRestOffset(tickerPause, 'center', 400, 100);
assert(restCenter === 150, 'ticker center rest = (box-span)/2');
const holdCenter = sampleCrawlMotion({
  localFrame: buildCrawlSchedule({
    lines: ['Hi'],
    crawl: tickerPause,
    boxWidth: 400,
    boxHeight: 80,
    fontSize: 48,
    fps: 50,
    align: 'center',
  }).phases[0]!.enterEnd + 1,
  lines: ['Hi'],
  crawl: tickerPause,
  boxW: 400,
  boxH: 80,
  fontSize: 48,
  fps: 50,
  measuredSpan: 100,
  align: 'center',
});
assert(holdCenter.x === 150, 'ticker+pause center hold uses align rest offset');

console.log('crawl-smoke: ALL OK');
