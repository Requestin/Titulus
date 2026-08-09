#!/usr/bin/env node
/**
 * P20 canonical semantic-cadence analyser.
 *
 * A DeckLink input rate is a delivery-health metric. This analyser instead
 * reconstructs the runtime rAF sequence recorded in FrameLog v2 and reports
 * how often the timeline produced distinct poses.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REQUIRED_COLUMNS = [
  'unix_us',
  'mono_us',
  'runtime_event_seq',
  'raf_seq',
  'ticks_per_raf',
  'logical_frame_after',
  'cef_paint_after',
  'publish_seq_after',
];

function parseCsv(text) {
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      record.push(field);
      field = '';
    } else if (character === '\n') {
      record.push(field.replace(/\r$/, ''));
      field = '';
      if (record.some((cell) => cell.length > 0)) records.push(record);
      record = [];
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('frame log CSV contains an unterminated quoted cell');
  if (field.length > 0 || record.length > 0) {
    record.push(field.replace(/\r$/, ''));
    if (record.some((cell) => cell.length > 0)) records.push(record);
  }
  if (records.length === 0) throw new Error('frame log CSV is empty or has no header');

  const headers = records.shift().map((header, index) => (
    index === 0 ? header.replace(/^\uFEFF/, '').trim() : header.trim()
  ));
  if (headers.some((header) => header.length === 0)) throw new Error('frame log CSV has an empty header');
  if (new Set(headers).size !== headers.length) throw new Error('frame log CSV has duplicate headers');
  const rows = records.map((cells, index) => {
    if (cells.length > headers.length) throw new Error(`frame log CSV row ${index + 2} has more fields than its header`);
    return Object.fromEntries(headers.map((header, column) => [header, cells[column] ?? '']));
  });
  Object.defineProperty(rows, 'headers', { value: headers, enumerable: false });
  return rows;
}

function unsigned(row, column) {
  const raw = row[column];
  if (raw === undefined || String(raw).trim() === '') throw new Error(`frame log row is missing ${column}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`frame log has invalid ${column}: ${raw}`);
  return value;
}

function assertColumns(rows) {
  if (!Array.isArray(rows)) throw new Error('rows must be a parsed FrameLog CSV array');
  for (const column of REQUIRED_COLUMNS) {
    if (!(rows.headers?.includes(column) ?? rows.some((row) => Object.hasOwn(row, column)))) {
      throw new Error(`FrameLog v2 requires ${column}`);
    }
  }
}

export function parseFrameLogCsv(text) {
  const rows = parseCsv(text);
  assertColumns(rows);
  const complete = [];
  let trailingPartialRows = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const incomplete = REQUIRED_COLUMNS.some((column) => (
      row[column] === undefined || String(row[column]).trim() === ''
    ));
    if (!incomplete) {
      complete.push(row);
      continue;
    }
    if (index !== rows.length - 1) {
      throw new Error(`incomplete FrameLog v2 row before EOF at row ${index + 2}`);
    }
    trailingPartialRows = 1;
  }
  Object.defineProperty(complete, 'headers', { value: rows.headers, enumerable: false });
  Object.defineProperty(complete, 'trailingPartialRows', {
    value: trailingPartialRows,
    enumerable: false,
  });
  return complete;
}

function eventFromRow(row) {
  return {
    unixUs: unsigned(row, 'unix_us'),
    monoUs: unsigned(row, 'mono_us'),
    runtimeEventSeq: unsigned(row, 'runtime_event_seq'),
    rafSeq: unsigned(row, 'raf_seq'),
    ticksPerRaf: unsigned(row, 'ticks_per_raf'),
    logicalFrameAfter: unsigned(row, 'logical_frame_after'),
    cefPaintAfter: unsigned(row, 'cef_paint_after'),
    publishSeqAfter: unsigned(row, 'publish_seq_after'),
  };
}

function stableEventSignature(event) {
  return [
    event.rafSeq,
    event.ticksPerRaf,
    event.logicalFrameAfter,
  ].join(':');
}

function dedupeRuntimeEvents(rows, warmupUnixUs, measurementEndUnixUs) {
  const events = [];
  const seen = new Map();
  let previousMonoUs = -1;
  for (const row of rows) {
    const event = eventFromRow(row);
    if (event.unixUs < warmupUnixUs) continue;
    if (measurementEndUnixUs !== undefined && event.unixUs >= measurementEndUnixUs) continue;
    if (event.monoUs < previousMonoUs) throw new Error('frame log mono_us must be non-decreasing');
    previousMonoUs = event.monoUs;
    if (event.runtimeEventSeq === 0) throw new Error('frame log has missing runtime provenance (runtime_event_seq=0)');
    const prior = seen.get(event.runtimeEventSeq);
    if (prior) {
      if (stableEventSignature(prior) !== stableEventSignature(event)) {
        throw new Error(`contradictory duplicate runtime_event_seq=${event.runtimeEventSeq}`);
      }
      continue;
    }
    seen.set(event.runtimeEventSeq, event);
    events.push(event);
  }
  if (events.length < 2) throw new Error('need at least two distinct runtime events after warm-up');
  for (let index = 1; index < events.length; index += 1) {
    if (events[index].runtimeEventSeq <= events[index - 1].runtimeEventSeq) {
      throw new Error('runtime_event_seq must strictly increase after de-duplication');
    }
    if (events[index].rafSeq <= events[index - 1].rafSeq) {
      throw new Error('raf_seq must strictly increase after de-duplication');
    }
  }
  return events;
}

function rate(numerator, events) {
  const durationUs = events.at(-1).monoUs - events[0].monoUs;
  if (durationUs <= 0) throw new Error('runtime events need increasing mono_us to calculate a rate');
  return Number((numerator * 1_000_000 / durationUs).toFixed(3));
}

function counterRate(events, field) {
  let increments = 0;
  for (let index = 1; index < events.length; index += 1) {
    const delta = events[index][field] - events[index - 1][field];
    if (delta < 0) throw new Error(`${field} must be non-decreasing`);
    increments += delta;
  }
  return rate(increments, events);
}

function tickPairDistribution(events) {
  const pairs = new Map();
  for (let index = 1; index < events.length; index += 1) {
    const key = `(${events[index - 1].ticksPerRaf},${events[index].ticksPerRaf})`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }
  const total = events.length - 1;
  const count = (key) => pairs.get(key) ?? 0;
  // The alternating attractor reads as 2,0,2,0… or as its phase-shifted
  // 0,2,0,2… form. Both describe the same 25-pose cadence; retain the
  // direction in `pairs`, but aggregate it for the verdict share.
  const twoZeroCount = count('(2,0)') + count('(0,2)');
  return {
    total,
    oneOne: Number((count('(1,1)') / total).toFixed(4)),
    twoZero: Number((twoZeroCount / total).toFixed(4)),
    other: Number(((total - count('(1,1)') - twoZeroCount) / total).toFixed(4)),
    pairs: Object.fromEntries([...pairs.entries()].sort(([left], [right]) => left.localeCompare(right))),
  };
}

/**
 * Boundaries are observed from a canonical run manifest; they do not infer
 * warm-up or shutdown duration from event counts or nominal wall time.
 */
export function analyzeP20Cadence(
  rows,
  { warmupUnixUs = 0, measurementEndUnixUs = undefined } = {},
) {
  assertColumns(rows);
  if (!Number.isSafeInteger(warmupUnixUs) || warmupUnixUs < 0) {
    throw new Error('warmupUnixUs must be a non-negative integer');
  }
  if (
    measurementEndUnixUs !== undefined
    && (!Number.isSafeInteger(measurementEndUnixUs) || measurementEndUnixUs <= warmupUnixUs)
  ) {
    throw new Error('measurementEndUnixUs must be an integer after warmupUnixUs');
  }
  const measuredRows = rows.filter((row) => {
    const unixUs = unsigned(row, 'unix_us');
    return unixUs >= warmupUnixUs
      && (measurementEndUnixUs === undefined || unixUs < measurementEndUnixUs);
  });
  const events = dedupeRuntimeEvents(rows, warmupUnixUs, measurementEndUnixUs);
  let positiveMotionTransitions = 0;
  for (let index = 1; index < events.length; index += 1) {
    if (events[index].logicalFrameAfter - events[index - 1].logicalFrameAfter > 0) {
      positiveMotionTransitions += 1;
    }
  }
  return {
    schemaVersion: 'p20-cadence-v1',
    sourceRows: rows.length,
    trailingPartialRows: rows.trailingPartialRows ?? 0,
    measuredRows: measuredRows.length,
    runtimeEvents: events.length,
    measurement: {
      startUnixUs: events[0].unixUs,
      endUnixUs: events.at(-1).unixUs,
      durationUs: events.at(-1).monoUs - events[0].monoUs,
    },
    tickPairDistribution: tickPairDistribution(events),
    logicalMotion: {
      positiveTransitions: positiveMotionTransitions,
      poseRate: rate(positiveMotionTransitions, events),
    },
    cefPaint: { rate: counterRate(events, 'cefPaintAfter') },
    publish: { rate: counterRate(events, 'publishSeqAfter') },
  };
}

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) continue;
    const [key, attached] = argument.slice(2).split(/=(.*)/s, 2);
    result[key] = attached ?? argv[index + 1];
    if (attached === undefined) index += 1;
  }
  return result;
}

export function main(argv = process.argv.slice(2)) {
  const opts = options(argv);
  if (!opts.in || opts.help) {
    process.stderr.write(
      'Usage: analyze-p20-cadence.mjs --in=frame.csv [--warmup-unix-us=US] '
      + '[--measurement-end-unix-us=US] [--out=report.json]\n',
    );
    return opts.help ? 0 : 1;
  }
  const warmupUnixUs = opts['warmup-unix-us'] === undefined
    ? 0
    : Number(opts['warmup-unix-us']);
  const measurementEndUnixUs = opts['measurement-end-unix-us'] === undefined
    ? undefined
    : Number(opts['measurement-end-unix-us']);
  const report = analyzeP20Cadence(
    parseFrameLogCsv(readFileSync(opts.in, 'utf8')),
    { warmupUnixUs, measurementEndUnixUs },
  );
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (opts.out) writeFileSync(opts.out, output);
  process.stdout.write(output);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`[analyze-p20-cadence] ${error.message}\n`);
    process.exitCode = 1;
  }
}
