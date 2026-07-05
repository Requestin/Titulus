#!/usr/bin/env node
/**
 * Parse Chrome trace JSON: Layout / Paint / Raster counts and JS profile summary.
 *
 * Usage:
 *   node engine/research/parse-chrome-trace.mjs --in=/tmp/trace.json --out=/tmp/trace-report.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

const inPath = arg('in', '');
const outPath = arg('out', '');

if (!inPath) {
  console.error('Usage: parse-chrome-trace.mjs --in=trace.json [--out=report.json]');
  process.exit(1);
}

/** @param {string} name */
function bucket(name) {
  const n = name.toLowerCase();
  if (n.includes('layout') || n.includes('performlayout')) return 'layout';
  if (n.includes('paint') || n.includes('paintchunk') || n.includes('updatelayertree')) return 'paint';
  if (n.includes('raster') || n.includes('drawframe') || n.includes('gputask')) return 'raster';
  if (n.includes('style') || n.includes('recalcstyle')) return 'style';
  if (n.includes('functioncall') || n.includes('v8.execute') || n.includes('v8.run')) return 'js';
  return null;
}

function main() {
  const raw = readFileSync(inPath, 'utf8');
  const trace = JSON.parse(raw);
  /** @type {Array<{name:string,cat?:string,ph?:string,ts?:number,dur?:number,pid?:number,tid?:number}>} */
  const events = trace.traceEvents || trace;

  const totals = { layout: 0, paint: 0, raster: 0, style: 0, js: 0, other: 0 };
  const durTotals = { layout: 0, paint: 0, raster: 0, style: 0, js: 0 };
  /** @type {Map<string, number>} */
  const nameCounts = new Map();
  /** @type {Map<string, number>} */
  const jsSelfTime = new Map();

  let drawFrames = 0;
  let beginFrames = 0;

  const frameMarkerNames = [
    'SendBeginMainFrame',
    'AnimationFrame::Render',
    'LocalFrameView::performLayout',
    'DrawFrame',
    'BeginFrame',
    'FireAnimationFrame',
  ];

  for (const ev of events) {
    if (!ev || typeof ev.name !== 'string') continue;
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

    // JS CPU profile samples (ProfileChunk / FunctionCall)
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

  const durationUs = events.reduce((max, ev) => Math.max(max, ev.ts || 0), 0)
    - events.reduce((min, ev) => (ev.ts != null ? Math.min(min, ev.ts) : min), Infinity);
  const durationSec = durationUs > 0 && durationUs < 120 * 1e6
    ? durationUs / 1e6
    : 15;

  let frameCount = 0;
  for (const marker of frameMarkerNames) {
    frameCount = Math.max(frameCount, nameCounts.get(marker) || 0);
  }
  const frameDenom = Math.max(frameCount, beginFrames, drawFrames, 1);

  const topNames = [...nameCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([name, count]) => ({ name, count }));

  const topJs = [...jsSelfTime.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([name, value]) => ({ name, value }));

  const report = {
    source: inPath,
    durationSec: Number(durationSec.toFixed(2)),
    eventCount: events.length,
    beginFrames,
    drawFrames,
    frameCount,
    perFrame: {
      layout: Number((totals.layout / frameDenom).toFixed(2)),
      paint: Number((totals.paint / frameDenom).toFixed(2)),
      raster: Number((totals.raster / frameDenom).toFixed(2)),
      style: Number((totals.style / frameDenom).toFixed(2)),
      jsEvents: Number((totals.js / frameDenom).toFixed(2)),
    },
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
    '',
    'Per-frame averages (events / frame):',
    `  Layout:  ${report.perFrame.layout}`,
    `  Paint:   ${report.perFrame.paint}`,
    `  Raster:  ${report.perFrame.raster}`,
    `  Style:   ${report.perFrame.style}`,
    `  JS ev:   ${report.perFrame.jsEvents}`,
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
}

main();
