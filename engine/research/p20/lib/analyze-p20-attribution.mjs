#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseStrictOptions } from './cli-options.mjs';
import { parseCsv } from './analyze-semantic-fields.mjs';

const joinWindowUs = 40_000;

function nearest(rows, unixUs) {
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const timestamp = Number(row.unix_us);
    if (!Number.isSafeInteger(timestamp)) continue;
    const distance = Math.abs(timestamp - unixUs);
    if (distance < bestDistance) {
      best = row;
      bestDistance = distance;
    }
  }
  return bestDistance <= joinWindowUs ? { row: best, distanceUs: bestDistance } : null;
}

function scheduleView(join) {
  if (!join) return null;
  return {
    distanceUs: join.distanceUs,
    scheduleSeq: Number(join.row.schedule_seq),
    freshCount: Number(join.row.fresh_count),
    wovenA: Number(join.row.woven_a),
    wovenB: Number(join.row.woven_b),
    weaveMode: join.row.weave_mode,
  };
}

function frameView(join) {
  if (!join) return null;
  return {
    distanceUs: join.distanceUs,
    association: 'inferred',
    beginFrameToken: Number(join.row.begin_frame_token),
    waitExitReason: join.row.wait_exit_reason ?? 'unknown',
    cefSeqAtSend: Number(join.row.cef_seq_at_send),
    cefPaintAfter: Number(join.row.cef_paint_after),
    publishSeqAfter: Number(join.row.publish_seq_after),
  };
}

function classification(schedule, frame) {
  if (schedule?.weaveMode === 'single' || schedule?.weaveMode === 'starved') {
    return frame?.waitExitReason === 'timeout'
      ? 'decklink_underflow_after_cef_timeout'
      : 'decklink_underflow';
  }
  if (schedule?.weaveMode === 'pair') return 'wire_or_field_order_unattributed';
  if (frame?.waitExitReason === 'timeout') return 'cef_timeout_without_schedule_join';
  return 'unattributed';
}

export function attributeSemanticAnomalies({ anomalies, scheduleRows, frameRows }) {
  const schedules = scheduleRows.filter((row) => row.event === 'schedule');
  const attributions = anomalies.map((anomaly) => {
    const schedule = scheduleView(nearest(schedules, anomaly.unixUs));
    const frame = frameView(nearest(frameRows, anomaly.unixUs));
    return {
      anomaly,
      classification: classification(schedule, frame),
      schedule,
      frame,
    };
  });
  const counts = {};
  for (const attribution of attributions) {
    counts[attribution.classification] = (counts[attribution.classification] ?? 0) + 1;
  }
  return {
    schemaVersion: 'p20-attribution-v1',
    joinWindowUs,
    anomalyCount: anomalies.length,
    counts,
    attributions,
  };
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseStrictOptions(argv, {
    allowed: new Set(['semantic', 'events', 'frame', 'out', 'help']),
    boolean: new Set(['help']),
  });
  if (!opts.semantic || !opts.events || !opts.frame || opts.help) {
    process.stderr.write(
      'Usage: analyze-p20-attribution.mjs --semantic=analysis.json '
      + '--events=decklink.csv --frame=frame.csv [--out=report.json]\n',
    );
    return opts.help ? 0 : 1;
  }
  const semantic = JSON.parse(readFileSync(opts.semantic, 'utf8'));
  const anomalies = (semantic.streams ?? []).flatMap((stream) => stream.anomalies ?? []);
  const report = attributeSemanticAnomalies({
    anomalies,
    scheduleRows: parseCsv(readFileSync(opts.events, 'utf8')),
    frameRows: parseCsv(readFileSync(opts.frame, 'utf8')),
  });
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (opts.out) writeFileSync(opts.out, output);
  process.stdout.write(output);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`[analyze-p20-attribution] ${error.message}\n`);
    process.exitCode = 1;
  }
}
