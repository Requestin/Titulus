#!/usr/bin/env node
/**
 * Internal metrics from Chrome trace: image decode, display list updates, raster.
 *
 * Usage:
 *   node engine/research/lib/parse-trace-internals.mjs --in=trace.json --label=scene [--out=report.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

const inPath = arg('in', '');
const label = arg('label', 'unknown');
const outPath = arg('out', '');

const COUNT_NAMES = [
  'SendBeginMainFrame',
  'LocalFrameView::performLayout',
  'Paint',
  'DisplayItemList::Raster',
  'RecordingSource::FinishDisplayItemListUpdate',
  'PaintController::commitNewDisplayItems',
  'ImageDecoder::DecodeFrameBufferAtIndex',
  'Draw LazyPixelRef',
  'LayerTreeImpl::InvalidateRegionForImages',
  'RasterTask',
];

function main() {
  const events = JSON.parse(readFileSync(inPath, 'utf8')).traceEvents || [];
  /** @type {Record<string, number>} */
  const counts = {};
  for (const name of COUNT_NAMES) counts[name] = 0;

  for (const ev of events) {
    const n = ev?.name;
    if (!n) continue;
    if (counts[n] !== undefined) counts[n] += 1;
  }

  const frames = Math.max(counts['SendBeginMainFrame'] || 0, 1);
  const perFrame = (k) => Number(((counts[k] || 0) / frames).toFixed(3));

  const report = {
    label,
    source: inPath,
    sendBeginMainFrame: counts['SendBeginMainFrame'],
    counts,
    perFrame: {
      layout: perFrame('LocalFrameView::performLayout'),
      paint: perFrame('Paint'),
      raster: perFrame('DisplayItemList::Raster'),
      recordingSourceUpdate: perFrame('RecordingSource::FinishDisplayItemListUpdate'),
      commitNewDisplayItems: perFrame('PaintController::commitNewDisplayItems'),
      imageDecode: perFrame('ImageDecoder::DecodeFrameBufferAtIndex'),
      drawLazyPixelRef: perFrame('Draw LazyPixelRef'),
      invalidateImageRegion: perFrame('LayerTreeImpl::InvalidateRegionForImages'),
    },
    recordingSourceRatio: Number(
      ((counts['RecordingSource::FinishDisplayItemListUpdate'] || 0) / frames).toFixed(3),
    ),
  };

  console.log(
    `[${label}] frames=${frames} layout=${report.perFrame.layout}/f `
    + `paint=${report.perFrame.paint}/f raster=${report.perFrame.raster}/f `
    + `imageDecode=${report.perFrame.imageDecode}/f `
    + `recordingSource=${report.recordingSourceRatio}/f`,
  );

  if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));
  return report;
}

main();
