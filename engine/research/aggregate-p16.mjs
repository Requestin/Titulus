#!/usr/bin/env node
// engine/research/aggregate-p16.mjs — collect P16 bench results into a single
// markdown table for the phase-16-performance-matrix.md report.
//
// Reads every bench-*.json in engine/research/results/p16/ and emits a table:
//   bench | fps | rasterMsTotal | rasterMsP50 | rasterMsP95 | rasterMsMax |
//   layoutMsTotal | paintMsTotal | rasterEventsMaxPerFrame
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'engine/research/results/p16';
const files = readdirSync(dir).filter(f => f.startsWith('bench-') && f.endsWith('.json'));

const rows = [];
for (const f of files.sort()) {
  const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const name = f.replace(/\.json$/, '');
  const totals = d.totals ?? {};
  const dist = d.perFrameDistribution ?? {};
  const rasterMs = dist.rasterMs ?? {};
  const layoutEvents = dist.layoutEvents ?? {};
  const rasterEvents = dist.rasterEvents ?? {};
  rows.push({
    name,
    rasterMsTotal: totals.raster ?? 0,
    rasterMsP50: rasterMs.p50 ?? 0,
    rasterMsP95: rasterMs.p95 ?? 0,
    rasterMsMax: rasterMs.max ?? 0,
    layoutMsTotal: totals.layout ?? 0,
    paintMsTotal: totals.paint ?? 0,
    layoutEventsMax: layoutEvents.max ?? 0,
    rasterEventsMax: rasterEvents.max ?? 0,
  });
}

// Print as markdown table.
const cols = ['bench', 'rasterMsTot', 'rasterP50', 'rasterP95', 'rasterMax', 'layoutMsTot', 'paintMsTot', 'rasterEvMax'];
console.log('| ' + cols.join(' | ') + ' |');
console.log('|' + cols.map(() => '---:').join('|') + '|');
for (const r of rows) {
  const fmt = (n) => Number(n).toFixed(1);
  console.log(`| ${r.name} | ${fmt(r.rasterMsTotal)} | ${fmt(r.rasterMsP50)} | ${fmt(r.rasterMsP95)} | ${fmt(r.rasterMsMax)} | ${fmt(r.layoutMsTotal)} | ${fmt(r.paintMsTotal)} | ${r.rasterEventsMax} |`);
}
