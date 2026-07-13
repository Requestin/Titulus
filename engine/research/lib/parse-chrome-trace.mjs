#!/usr/bin/env node
/**
 * Parse Chrome trace JSON: per-frame Layout / Paint / Raster / Style / JS
 * event counts and durations, plus sub-category breakdown and JS profile
 * summary.
 *
 * Phase 15 P0: extended from the Phase 12 version to support per-frame
 * (not just trace-wide average) aggregation, because the trace-wide average
 * hides which frames are expensive (e.g. a rotating mask that is only
 * expensive while animating) and cannot be compared meaningfully across a
 * cost matrix (Phase 15 P1) without a distribution (p50/p95/max).
 *
 * Usage:
 *   node engine/research/lib/parse-chrome-trace.mjs --in=/tmp/trace.json \
 *     [--out=/tmp/report.json] [--out-csv=/tmp/report.csv] \
 *     [--heavy-frames-threshold=2]
 */
import { readFileSync, writeFileSync } from 'node:fs';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

const inPath = arg('in', '');
const outPath = arg('out', '');
const outCsvPath = arg('out-csv', '');
const heavyThreshold = Number(arg('heavy-frames-threshold', '2'));

if (!inPath) {
  console.error(
    'Usage: parse-chrome-trace.mjs --in=trace.json [--out=report.json] ' +
      '[--out-csv=report.csv] [--heavy-frames-threshold=2]',
  );
  process.exit(1);
}

/** Top-level bucket used for the legacy trace-wide summary (kept for compat). */
function bucket(name) {
  const n = name.toLowerCase();
  if (n.includes('layout') || n.includes('performlayout')) return 'layout';
  if (n.includes('paint') || n.includes('paintchunk') || n.includes('updatelayertree')) return 'paint';
  if (n.includes('raster') || n.includes('drawframe') || n.includes('gputask')) return 'raster';
  if (n.includes('style') || n.includes('recalcstyle')) return 'style';
  if (n.includes('functioncall') || n.includes('v8.execute') || n.includes('v8.run')) return 'js';
  return null;
}

/**
 * Finer-grained sub-category used for the class A/B/C breakdown (Phase 15
 * P2 inventory): which exact pipeline stage is expensive, not just "paint".
 * Keys match the pipeline stage names emitted by Blink/cc trace events.
 */
function subCategory(name) {
  const n = name.toLowerCase();
  if (n.includes('performlayout')) return 'layout.performLayout';
  if (n.includes('updatelayout')) return 'layout.updateLayout';
  if (n.includes('paintchunk')) return 'paint.chunk';
  if (n.includes('updatelayertree')) return 'paint.updateLayerTree';
  if (n === 'paint') return 'paint.paint';
  if (n.includes('rastertask')) return 'raster.task';
  if (n.includes('gputask')) return 'raster.gpuTask';
  if (n.includes('drawframe')) return 'raster.drawFrame';
  if (n.includes('recalcstyle')) return 'style.recalc';
  if (n.includes('invalidat')) return 'invalidation';
  return null;
}

const frameMarkerNames = [
  'SendBeginMainFrame',
  'AnimationFrame::Render',
  'LocalFrameView::performLayout',
  'DrawFrame',
  'BeginFrame',
  'FireAnimationFrame',
];
// Preferred marker to slice the trace into per-frame windows — the first
// name in this list that appears at least twice in the trace is used.
const framePreference = ['BeginFrame', 'SendBeginMainFrame', 'DrawFrame', 'FireAnimationFrame'];

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function main() {
  const raw = readFileSync(inPath, 'utf8');
  const trace = JSON.parse(raw);
  /** @type {Array<{name:string,cat?:string,ph?:string,ts?:number,dur?:number,pid?:number,tid?:number,args?:any}>} */
  const events = (trace.traceEvents || trace).filter((ev) => ev && typeof ev.name === 'string');
  events.sort((a, b) => (a.ts || 0) - (b.ts || 0));

  const totals = { layout: 0, paint: 0, raster: 0, style: 0, js: 0, other: 0 };
  const durTotals = { layout: 0, paint: 0, raster: 0, style: 0, js: 0 };
  /** @type {Map<string, number>} */
  const nameCounts = new Map();
  /** @type {Map<string, number>} */
  const jsSelfTime = new Map();
  /** @type {Map<string, {count:number, durUs:number}>} */
  const subCounts = new Map();

  let drawFrames = 0;
  let beginFrames = 0;

  for (const ev of events) {
    nameCounts.set(ev.name, (nameCounts.get(ev.name) || 0) + 1);

    if (ev.name === 'DrawFrame' || ev.name === 'CompositeLayers') drawFrames += 1;
    if (ev.name === 'BeginFrame' || ev.name === 'SendBeginMainFrame') beginFrames += 1;

    const b = bucket(ev.name);
    if (b) {
      totals[b] += 1;
      if (typeof ev.dur === 'number') durTotals[b] += ev.dur;
    } else if (ev.cat && (ev.cat.includes('blink') || ev.cat.includes('devtools'))) {
      totals.other += 1;
    }

    const sc = subCategory(ev.name);
    if (sc) {
      const entry = subCounts.get(sc) || { count: 0, durUs: 0 };
      entry.count += 1;
      entry.durUs += typeof ev.dur === 'number' ? ev.dur : 0;
      subCounts.set(sc, entry);
    }

    if (ev.name === 'FunctionCall' && typeof ev.dur === 'number' && ev.args?.data?.functionName) {
      const fn = String(ev.args.data.functionName);
      jsSelfTime.set(fn, (jsSelfTime.get(fn) || 0) + ev.dur);
    }
    if (ev.name === 'ProfileChunk' && ev.args?.data?.cpuProfile?.nodes) {
      const { nodes, samples } = ev.args.data.cpuProfile;
      if (Array.isArray(nodes) && Array.isArray(samples)) {
        for (let i = 0; i < samples.length; i++) {
          const nodeId = samples[i];
          const node = nodes.find((n) => n.id === nodeId);
          if (node?.callFrame?.functionName) {
            const fn = node.callFrame.functionName;
            jsSelfTime.set(fn, (jsSelfTime.get(fn) || 0) + 1);
          }
        }
      }
    }
  }

  // Avoid Math.max(...array)/spread on large arrays (stack overflow on
  // multi-hundred-thousand-event traces) — reduce with a plain loop instead.
  let tsMin = Infinity;
  let tsMax = -Infinity;
  for (const ev of events) {
    if (typeof ev.ts !== 'number') continue;
    if (ev.ts < tsMin) tsMin = ev.ts;
    if (ev.ts > tsMax) tsMax = ev.ts;
  }
  const durationUs = tsMax >= tsMin ? tsMax - tsMin : 0;
  const durationSec = durationUs > 0 && durationUs < 120 * 1e6 ? durationUs / 1e6 : 15;

  let frameCount = 0;
  for (const marker of frameMarkerNames) {
    frameCount = Math.max(frameCount, nameCounts.get(marker) || 0);
  }
  const frameDenom = Math.max(frameCount, beginFrames, drawFrames, 1);

  // --- Per-frame slicing (Phase 15 P0) ---------------------------------
  // Slice the timeline at each occurrence of the chosen frame marker, then
  // count Layout/Paint/Raster/Style events falling inside each slice. This
  // gives a distribution (p50/p95/max), not just a trace-wide average —
  // necessary to see whether a specific animation (e.g. a rotating mask)
  // produces occasional heavy frames that an average would hide.
  let markerName = framePreference.find((m) => (nameCounts.get(m) || 0) >= 2);
  /** @type {Array<{frameIdx:number, tsStart:number, layout:number, paint:number, raster:number, style:number, rasterDurUs:number}>} */
  const perFrameRows = [];

  if (markerName) {
    const markerTimes = events.filter((ev) => ev.name === markerName).map((ev) => ev.ts);
    // Single linear sweep over the (already ts-sorted) events with a moving
    // frame-window pointer, instead of re-scanning the full event list per
    // frame slice — O(frames + events) instead of O(frames * events), which
    // matters once soak traces (P5) run 60s+ with hundreds of thousands of
    // events across thousands of frame slices.
    for (let i = 0; i < markerTimes.length; i++) {
      const start = markerTimes[i];
      const end = i + 1 < markerTimes.length ? markerTimes[i + 1] : Infinity;
      perFrameRows.push({ frameIdx: i, tsStart: start, tsEnd: end, layout: 0, paint: 0, raster: 0, style: 0, rasterDurUs: 0 });
    }
    let frameIdx = 0;
    for (const ev of events) {
      if (ev.ts == null || frameIdx >= perFrameRows.length) continue;
      while (frameIdx < perFrameRows.length - 1 && ev.ts >= perFrameRows[frameIdx].tsEnd) {
        frameIdx += 1;
      }
      if (ev.ts < perFrameRows[frameIdx].tsStart) continue; // events before the first marker
      const row = perFrameRows[frameIdx];
      const b = bucket(ev.name);
      if (b === 'layout') row.layout += 1;
      else if (b === 'paint') row.paint += 1;
      else if (b === 'raster') {
        row.raster += 1;
        if (typeof ev.dur === 'number') row.rasterDurUs += ev.dur;
      } else if (b === 'style') row.style += 1;
    }
  }

  const rasterDurSorted = perFrameRows.map((r) => r.rasterDurUs / 1000).sort((a, b) => a - b);
  const layoutSorted = perFrameRows.map((r) => r.layout).sort((a, b) => a - b);
  const paintSorted = perFrameRows.map((r) => r.paint).sort((a, b) => a - b);
  const rasterCountSorted = perFrameRows.map((r) => r.raster).sort((a, b) => a - b);

  const distribution = (sorted) => ({
    p50: Number(percentile(sorted, 50).toFixed(3)),
    p95: Number(percentile(sorted, 95).toFixed(3)),
    max: sorted.length ? Number(sorted[sorted.length - 1].toFixed(3)) : 0,
  });

  const perFrameDistribution = {
    layoutEvents: distribution(layoutSorted),
    paintEvents: distribution(paintSorted),
    rasterEvents: distribution(rasterCountSorted),
    rasterMs: distribution(rasterDurSorted),
  };

  // Heavy frames: raster event count > heavyThreshold * p50 (or > p95 as a
  // floor when p50 is 0, so a template with almost no raster cost doesn't
  // flag every frame as "heavy").
  const rasterP50 = perFrameDistribution.rasterEvents.p50;
  const heavyFloor = Math.max(rasterP50 * heavyThreshold, perFrameDistribution.rasterEvents.p95, 1);
  const heavyFrames = perFrameRows
    .filter((r) => r.raster > heavyFloor)
    .map((r) => ({ frameIdx: r.frameIdx, tsStart: r.tsStart, raster: r.raster, rasterMs: Number((r.rasterDurUs / 1000).toFixed(3)) }));

  const topNames = [...nameCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([name, count]) => ({ name, count }));

  const topJs = [...jsSelfTime.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([name, value]) => ({ name, value }));

  const subCategoryBreakdown = [...subCounts.entries()]
    .map(([name, v]) => ({ name, count: v.count, durMs: Number((v.durUs / 1000).toFixed(2)) }))
    .sort((a, b) => b.durMs - a.durMs);

  const report = {
    source: inPath,
    durationSec: Number(durationSec.toFixed(2)),
    eventCount: events.length,
    beginFrames,
    drawFrames,
    frameCount,
    frameMarkerUsedForSlicing: markerName || null,
    perFrameSliceCount: perFrameRows.length,
    perFrame: {
      layout: Number((totals.layout / frameDenom).toFixed(2)),
      paint: Number((totals.paint / frameDenom).toFixed(2)),
      raster: Number((totals.raster / frameDenom).toFixed(2)),
      style: Number((totals.style / frameDenom).toFixed(2)),
      jsEvents: Number((totals.js / frameDenom).toFixed(2)),
    },
    perFrameDistribution,
    heavyFrames,
    subCategoryBreakdown,
    totals,
    durMs: {
      layout: Number((durTotals.layout / 1000).toFixed(2)),
      paint: Number((durTotals.paint / 1000).toFixed(2)),
      raster: Number((durTotals.raster / 1000).toFixed(2)),
      style: Number((durTotals.style / 1000).toFixed(2)),
      js: Number((durTotals.js / 1000).toFixed(2)),
    },
    topEventNames: topNames,
    topJsSymbols: topJs,
  };

  const text = [
    `Trace: ${inPath}`,
    `Duration: ~${report.durationSec}s | events=${report.eventCount} | frames≈${report.frameCount} (SendBeginMainFrame=${report.beginFrames})`,
    `Per-frame slicing marker: ${report.frameMarkerUsedForSlicing || '(none found — distribution unavailable)'} | slices=${report.perFrameSliceCount}`,
    '',
    'Per-frame averages (trace-wide, events / frame):',
    `  Layout:  ${report.perFrame.layout}`,
    `  Paint:   ${report.perFrame.paint}`,
    `  Raster:  ${report.perFrame.raster}`,
    `  Style:   ${report.perFrame.style}`,
    `  JS ev:   ${report.perFrame.jsEvents}`,
    '',
    'Per-frame distribution (p50 / p95 / max):',
    `  Layout events:  ${perFrameDistribution.layoutEvents.p50} / ${perFrameDistribution.layoutEvents.p95} / ${perFrameDistribution.layoutEvents.max}`,
    `  Paint events:   ${perFrameDistribution.paintEvents.p50} / ${perFrameDistribution.paintEvents.p95} / ${perFrameDistribution.paintEvents.max}`,
    `  Raster events:  ${perFrameDistribution.rasterEvents.p50} / ${perFrameDistribution.rasterEvents.p95} / ${perFrameDistribution.rasterEvents.max}`,
    `  Raster ms:      ${perFrameDistribution.rasterMs.p50} / ${perFrameDistribution.rasterMs.p95} / ${perFrameDistribution.rasterMs.max}`,
    '',
    `Heavy frames (raster events > ${heavyThreshold}x p50, floor=${heavyFloor.toFixed(1)}): ${heavyFrames.length}`,
    ...heavyFrames.slice(0, 10).map((h) => `  frame#${h.frameIdx} raster=${h.raster} (${h.rasterMs}ms)`),
    '',
    'Sub-category breakdown (durMs desc, top 15):',
    ...subCategoryBreakdown.slice(0, 15).map((r) => `  ${r.name}: count=${r.count} durMs=${r.durMs}`),
    '',
    'Total duration (ms, slice dur sum where present):',
    `  Layout=${report.durMs.layout} Paint=${report.durMs.paint} Raster=${report.durMs.raster} Style=${report.durMs.style} JS=${report.durMs.js}`,
    '',
    'Top JS symbols (sample weight):',
    ...report.topJsSymbols.slice(0, 15).map((r) => `  ${r.name}: ${r.value}`),
  ].join('\n');

  console.log(text);

  if (outPath) {
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`\n[parse] wrote ${outPath}`);
  }

  if (outCsvPath) {
    const header = 'frameIdx,tsStart,layoutEvents,paintEvents,rasterEvents,rasterMs,styleEvents';
    const rows = perFrameRows.map(
      (r) => `${r.frameIdx},${r.tsStart},${r.layout},${r.paint},${r.raster},${(r.rasterDurUs / 1000).toFixed(3)},${r.style}`,
    );
    writeFileSync(outCsvPath, [header, ...rows].join('\n') + '\n');
    console.log(`[parse] wrote ${outCsvPath} (${rows.length} rows)`);
  }
}

main();
