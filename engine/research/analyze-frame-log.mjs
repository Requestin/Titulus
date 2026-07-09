#!/usr/bin/env node
/**
 * Phase 17: parse the CSV produced by bg_engine's `--frame-log=PATH` flag
 * and report percentiles that distinguish "raster pool undersaturated"
 * (hypothesis A: the CEF renderer isn't given enough raster work to keep
 * its thread pool busy) vs "IPC latency bound" (hypothesis B: pump/paint
 * round-trips dominate the frame interval, not raster work itself).
 *
 * CSV format (header row always present, one row per pump tick):
 *   wall_clock_us,interval_us,paint_seq,pump_active_us,paint_latency_us,waited_deadline
 *
 * Usage:
 *   node engine/research/analyze-frame-log.mjs --in=/tmp/frame-log.csv \
 *     [--out=/tmp/report.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

const inPath = arg('in', '');
const outPath = arg('out', '');

if (!inPath) {
  console.error('Usage: analyze-frame-log.mjs --in=frame-log.csv [--out=report.json]');
  process.exit(1);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sorted.length ? sum / sorted.length : 0;
  return {
    p50: Number(percentile(sorted, 50).toFixed(2)),
    p95: Number(percentile(sorted, 95).toFixed(2)),
    max: sorted.length ? Number(sorted[sorted.length - 1].toFixed(2)) : 0,
    mean: Number(mean.toFixed(2)),
  };
}

function main() {
  const raw = readFileSync(inPath, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const header = lines[0]?.split(',').map((h) => h.trim()) || [];
  const col = (name) => header.indexOf(name);

  const iInterval = col('interval_us');
  const iPumpActive = col('pump_active_us');
  const iPaintLatency = col('paint_latency_us');
  const iWaited = col('waited_deadline');
  const iInflight = col('inflight_depth');
  const iPaintDelta = col('paint_seq_delta');

  const dataLines = lines.slice(1);
  const totalRows = dataLines.length;

  const intervalDelivered = [];
  const pumpActiveAll = [];
  const paintLatencyAll = [];
  const paintSeqDeltaAll = [];
  let deliveredFrames = 0;
  let timedOutTicks = 0;
  let sumPumpActiveDelivered = 0;
  let sumIntervalDelivered = 0;
  let ticksWithDeltaGe2 = 0;
  let ticksWithDeltaGe1 = 0;
  let maxInflight = 0;

  for (const line of dataLines) {
    const cells = line.split(',');
    const intervalUs = Number(cells[iInterval]);
    const pumpActiveUs = Number(cells[iPumpActive]);
    const paintLatencyUs = Number(cells[iPaintLatency]);
    const waitedDeadline = Number(cells[iWaited]);
    const inflight = iInflight >= 0 ? Number(cells[iInflight]) : 0;
    const paintDelta = iPaintDelta >= 0 ? Number(cells[iPaintDelta]) : 0;

    pumpActiveAll.push(pumpActiveUs);
    paintLatencyAll.push(paintLatencyUs);
    if (iPaintDelta >= 0) paintSeqDeltaAll.push(paintDelta);
    if (waitedDeadline === 1) timedOutTicks += 1;
    if (paintDelta >= 2) ticksWithDeltaGe2 += 1;
    if (paintDelta >= 1) ticksWithDeltaGe1 += 1;
    if (inflight > maxInflight) maxInflight = inflight;

    // interval_us === 0 means no frame was delivered this row — exclude
    // from interval stats but keep counted in the all-rows stats above.
    if (intervalUs > 0) {
      deliveredFrames += 1;
      intervalDelivered.push(intervalUs);
      sumPumpActiveDelivered += pumpActiveUs;
      sumIntervalDelivered += intervalUs;
    }
  }

  const intervalUsDist = distribution(intervalDelivered);
  const pumpActiveUsDist = distribution(pumpActiveAll);
  const paintLatencyUsDist = distribution(paintLatencyAll);
  const paintSeqDeltaDist = distribution(paintSeqDeltaAll);

  // sum/sum instead of mean-of-per-row-ratios: robust to outlier rows
  // (e.g. a single tick with near-zero interval_us would otherwise blow up
  // an individual ratio and skew a simple average of ratios).
  const pumpActiveRatio = sumIntervalDelivered > 0 ? Number((sumPumpActiveDelivered / sumIntervalDelivered).toFixed(4)) : 0;
  const effectiveFps = intervalUsDist.mean > 0 ? Number((1e6 / intervalUsDist.mean).toFixed(2)) : 0;

  const report = {
    source: inPath,
    totalRows,
    deliveredFrames,
    timedOutTicks,
    intervalUs: intervalUsDist,
    pumpActiveUs: pumpActiveUsDist,
    paintLatencyUs: paintLatencyUsDist,
    pumpActiveRatio,
    effectiveFps,
    // Phase 18 P0.2 fields (0/absent when probe off / old CSV).
    paintSeqDelta: paintSeqDeltaDist,
    ticksWithDeltaGe2,
    ticksWithDeltaGe1,
    maxInflight,
    pctTicksDeltaGe2: totalRows ? Number(((100 * ticksWithDeltaGe2) / totalRows).toFixed(2)) : 0,
  };

  const lines_ = [
    `Frame log: ${inPath}`,
    `Rows: ${totalRows} | delivered=${deliveredFrames} | timedOutTicks=${timedOutTicks}`,
    '',
    'interval_us (delivered frames only) p50/p95/max/mean:',
    `  ${intervalUsDist.p50} / ${intervalUsDist.p95} / ${intervalUsDist.max} / ${intervalUsDist.mean}`,
    'pump_active_us (all rows) p50/p95/max/mean:',
    `  ${pumpActiveUsDist.p50} / ${pumpActiveUsDist.p95} / ${pumpActiveUsDist.max} / ${pumpActiveUsDist.mean}`,
    'paint_latency_us (all rows) p50/p95/max/mean:',
    `  ${paintLatencyUsDist.p50} / ${paintLatencyUsDist.p95} / ${paintLatencyUsDist.max} / ${paintLatencyUsDist.mean}`,
    '',
    `pumpActiveRatio (sum(pump_active_us)/sum(interval_us), delivered frames): ${pumpActiveRatio}`,
    `effectiveFps (1e6 / mean interval_us): ${effectiveFps}`,
    '',
  ];

  if (iPaintDelta >= 0) {
    lines_.push(
      'Phase 18 P0.2 paint_seq_delta (unique OnPaints per tick) p50/p95/max/mean:',
      `  ${paintSeqDeltaDist.p50} / ${paintSeqDeltaDist.p95} / ${paintSeqDeltaDist.max} / ${paintSeqDeltaDist.mean}`,
      `ticks with paint_seq_delta≥2: ${ticksWithDeltaGe2}/${totalRows} (${report.pctTicksDeltaGe2}%)`,
      `ticks with paint_seq_delta≥1: ${ticksWithDeltaGe1}/${totalRows}`,
      `max inflight_depth observed: ${maxInflight}`,
      '',
    );
  }

  // Heuristic hint only — NOT a conclusion. The real Phase 17 A/B verdict
  // is decided by a human after the full experiment; this is just a nudge
  // toward which hypothesis's supporting numbers to look at next.
  if (iPaintDelta >= 0 && maxInflight >= 2) {
    if (report.pctTicksDeltaGe2 >= 50) {
      lines_.push('Heuristic hint (P18): CEF likely pipelines dual BeginFrame (Approach A signal)');
    } else if (report.pctTicksDeltaGe2 < 5) {
      lines_.push('Heuristic hint (P18): CEF coalesces dual BeginFrame (Approach B / Fallback signal)');
    } else {
      lines_.push('Heuristic hint (P18): partial pipeline — inspect paint_seq_delta distribution');
    }
  } else if (pumpActiveRatio > 0.6) {
    lines_.push('Heuristic hint: raster pool likely saturated (hypothesis A signal)');
  } else if (pumpActiveRatio < 0.3) {
    lines_.push('Heuristic hint: large idle/latency gap relative to pump work (hypothesis B signal)');
  } else {
    lines_.push('Heuristic hint: ambiguous — inspect paint_latency_us distribution');
  }

  console.log(lines_.join('\n'));

  if (outPath) {
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`\n[analyze] wrote ${outPath}`);
  }
}

main();
