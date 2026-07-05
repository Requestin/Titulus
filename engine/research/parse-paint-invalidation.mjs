#!/usr/bin/env node
/**
 * Parse Chrome trace for paint/layout invalidation events and reasons.
 *
 * Usage:
 *   node engine/research/parse-paint-invalidation.mjs --in=trace.json [--out=report.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

const inPath = arg('in', '');
const outPath = arg('out', '');

if (!inPath) {
  console.error('Usage: parse-paint-invalidation.mjs --in=trace.json [--out=report.json]');
  process.exit(1);
}

const INVALID_NAMES = [
  'InvalidatePaint',
  'PaintInvalidation',
  'SchedulePaintInvalidation',
  'InvalidateLayout',
  'LayoutInvalidation',
  'SetNeedsPaint',
  'PaintChunk',
  'PaintController::commitNewDisplayItems',
  'LayerTreeImpl::InvalidateRegionForImages',
  'PrePaint',
  'Paint',
];

function reasonFromArgs(args) {
  if (!args) return null;
  if (typeof args.data?.reason === 'string') return args.data.reason;
  if (typeof args.reason === 'string') return args.reason;
  if (typeof args.data?.invalidationReason === 'string') return args.data.invalidationReason;
  if (typeof args.data?.debugName === 'string') return args.data.debugName;
  if (typeof args.data?.name === 'string') return args.data.name;
  return null;
}

function main() {
  const raw = readFileSync(inPath, 'utf8');
  const trace = JSON.parse(raw);
  const events = trace.traceEvents || trace;

  /** @type {Map<string, number>} */
  const nameCounts = new Map();
  /** @type {Map<string, number>} */
  const reasons = new Map();
  let beginMain = 0;

  for (const ev of events) {
    if (!ev || typeof ev.name !== 'string') continue;
    const n = ev.name;
    if (n === 'SendBeginMainFrame') beginMain += 1;

    const isInvalid = INVALID_NAMES.some((k) => n.includes(k))
      || n.toLowerCase().includes('invalid');
    if (!isInvalid) continue;

    nameCounts.set(n, (nameCounts.get(n) || 0) + 1);
    const reason = reasonFromArgs(ev.args);
    if (reason) reasons.set(reason, (reasons.get(reason) || 0) + 1);
  }

  const topNames = [...nameCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([name, count]) => ({ name, count }));

  const topReasons = [...reasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([reason, count]) => ({ reason, count }));

  const frameDenom = Math.max(beginMain, 1);
  const report = {
    source: inPath,
    sendBeginMainFrame: beginMain,
    perFrame: {
      invalidateLayout: Number(((nameCounts.get('InvalidateLayout') || 0) / frameDenom).toFixed(3)),
      commitNewDisplayItems: Number(
        ((nameCounts.get('PaintController::commitNewDisplayItems') || 0) / frameDenom).toFixed(3),
      ),
      invalidateRegionForImages: Number(
        ((nameCounts.get('LayerTreeImpl::InvalidateRegionForImages') || 0) / frameDenom).toFixed(3),
      ),
    },
    topInvalidationEvents: topNames,
    topReasonStrings: topReasons,
  };

  const lines = [
    `Invalidation parse: ${inPath}`,
    `SendBeginMainFrame=${beginMain}`,
    `InvalidateLayout/frame=${report.perFrame.invalidateLayout}`,
    `commitNewDisplayItems/frame=${report.perFrame.commitNewDisplayItems}`,
    `InvalidateRegionForImages/frame=${report.perFrame.invalidateRegionForImages}`,
    '',
    'Top invalidation event names:',
    ...topNames.slice(0, 15).map((r) => `  ${r.name}: ${r.count}`),
    '',
    'Top reason strings (when present in trace args):',
    ...(topReasons.length
      ? topReasons.slice(0, 15).map((r) => `  ${r.reason}: ${r.count}`)
      : ['  (none — enable invalidationTracking categories)']),
  ];
  console.log(lines.join('\n'));

  if (outPath) {
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`\n[parse-invalidation] wrote ${outPath}`);
  }
}

main();
