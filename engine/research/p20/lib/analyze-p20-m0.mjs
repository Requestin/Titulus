#!/usr/bin/env node
/**
 * Formal P20.1 M0 verifier for one DeckLink completion-event CSV.
 *
 * It deliberately proves only logger/provenance health. Semantic cadence is
 * evaluated separately by analyze-p20-cadence.mjs and on-wire identity by
 * P20.2 capture-fields analysis.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REQUIRED_COLUMNS = [
  'event',
  'schedule_seq',
  'unix_us',
  'mono_us',
  'fresh_count',
  'woven_a',
  'woven_b',
  'weave_mode',
];

function parseCsv(text) {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error('DeckLink event CSV is empty');
  const headers = lines.shift().replace(/^\uFEFF/, '').split(',').map((value) => value.trim());
  if (new Set(headers).size !== headers.length) throw new Error('DeckLink event CSV has duplicate headers');
  for (const column of REQUIRED_COLUMNS) {
    if (!headers.includes(column)) throw new Error(`DeckLink event CSV requires ${column}`);
  }
  const rows = [];
  for (let index = 0; index < lines.length; index += 1) {
    const cells = lines[index].split(',');
    if (cells.length < headers.length) {
      if (index !== lines.length - 1) {
        throw new Error(`incomplete DeckLink event row before EOF at row ${index + 2}`);
      }
      continue;
    }
    if (cells.length > headers.length) throw new Error(`DeckLink event row ${index + 2} has extra fields`);
    rows.push(Object.fromEntries(headers.map((header, cell) => [header, cells[cell] ?? ''])));
  }
  Object.defineProperty(rows, 'headers', { value: headers, enumerable: false });
  return rows;
}

function positive(row, name) {
  const value = Number(row[name]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`DeckLink event has invalid ${name}: ${row[name]}`);
  }
  return value;
}

export function parseDecklinkEvents(text) {
  const rows = parseCsv(text);
  let previousUnixUs = 0;
  let previousMonoUs = 0;
  for (const row of rows) {
    if (!['schedule', 'completion', 'input_overwrite', 'reference_change'].includes(row.event)) {
      throw new Error(`DeckLink event has invalid event type: ${row.event}`);
    }
    positive(row, 'schedule_seq');
    const unixUs = positive(row, 'unix_us');
    const monoUs = positive(row, 'mono_us');
    if (unixUs < previousUnixUs) {
      throw new Error(`DeckLink event unix_us is not non-decreasing: ${unixUs} < ${previousUnixUs}`);
    }
    if (monoUs < previousMonoUs) {
      throw new Error(`DeckLink event mono_us is not non-decreasing: ${monoUs} < ${previousMonoUs}`);
    }
    previousUnixUs = unixUs;
    previousMonoUs = monoUs;
  }
  return rows;
}

function finalTelemetry(engineLog) {
  const matches = [...engineLog.matchAll(
    /telemetry in=\d+ scheduled=\d+ late=(\d+) dropped=(\d+) flushed=(\d+) overwrite=(\d+).*?event_overflow=(\d+)/g,
  )];
  if (matches.length === 0) throw new Error('engine log has no final DeckLink telemetry');
  const match = matches.at(-1);
  return {
    late: Number(match[1]),
    dropped: Number(match[2]),
    flushed: Number(match[3]),
    overwrite: Number(match[4]),
    eventOverflow: Number(match[5]),
  };
}

function validateScheduleSources(schedules) {
  const errors = [];
  for (const schedule of schedules) {
    if (schedule.weave_mode !== 'pair') continue;
    const first = positive(schedule, 'woven_a');
    const second = positive(schedule, 'woven_b');
    if (second !== first + 1) {
      errors.push(`pair schedule_seq=${schedule.schedule_seq} does not contain adjacent source IDs`);
      continue;
    }
  }
  return errors;
}

export function analyzeP20M0({ eventRows, engineLog }) {
  if (!Array.isArray(eventRows)) throw new Error('eventRows must be a parsed DeckLink event CSV array');
  if (typeof engineLog !== 'string') throw new Error('engineLog must be a string');

  const errors = [];
  const schedules = eventRows.filter((row) => row.event === 'schedule');
  const prerollCompletions = eventRows.filter(
    (row) => row.event === 'completion' && positive(row, 'schedule_seq') === 0,
  );
  const completions = eventRows.filter(
    (row) => row.event === 'completion' && positive(row, 'schedule_seq') !== 0,
  );
  const overwrites = eventRows.filter((row) => row.event === 'input_overwrite');
  const overwrittenSourceIds = new Set();
  for (const overwrite of overwrites) {
    const sourceId = positive(overwrite, 'popped_a');
    if (sourceId === 0) errors.push('input_overwrite without popped_a source ID');
    if (overwrittenSourceIds.has(sourceId)) {
      errors.push(`duplicate input_overwrite source_id=${sourceId}`);
    }
    overwrittenSourceIds.add(sourceId);
  }
  const scheduleBySeq = new Map();
  for (const schedule of schedules) {
    const seq = positive(schedule, 'schedule_seq');
    if (scheduleBySeq.has(seq)) errors.push(`duplicate schedule_seq=${seq}`);
    scheduleBySeq.set(seq, schedule);
  }
  const completed = new Set();
  for (const completion of completions) {
    const seq = positive(completion, 'schedule_seq');
    if (!scheduleBySeq.has(seq)) errors.push(`completion without schedule_seq=${seq}`);
    if (completed.has(seq)) errors.push(`duplicate completion for schedule_seq=${seq}`);
    completed.add(seq);
  }

  const scheduleSeqs = [...scheduleBySeq.keys()].sort((left, right) => left - right);
  const unmatched = scheduleSeqs.filter((seq) => !completed.has(seq));
  const firstUnmatched = unmatched[0] ?? null;
  if (firstUnmatched !== null) {
    const expectedTail = scheduleSeqs.slice(scheduleSeqs.indexOf(firstUnmatched));
    if (unmatched.length > 3 || expectedTail.length !== unmatched.length
        || !expectedTail.every((seq, index) => seq === unmatched[index])) {
      for (const seq of unmatched) errors.push(`missing completion for schedule_seq=${seq}`);
    }
  }

  errors.push(...validateScheduleSources(schedules));
  const telemetry = finalTelemetry(engineLog);
  for (const [name, value] of Object.entries(telemetry)) {
    if (name === 'overwrite') continue;
    if (value !== 0) errors.push(`${name === 'eventOverflow' ? 'event_overflow' : name}=${value}`);
  }
  if (telemetry.overwrite !== overwrites.length) {
    errors.push(`overwrite telemetry=${telemetry.overwrite} differs from input_overwrite events=${overwrites.length}`);
  }

  return {
    schemaVersion: 'p20-m0-v1',
    schedules: schedules.length,
    completions: completions.length,
    prerollCompletions: prerollCompletions.length,
    inputOverwrites: overwrites.length,
    shutdownTail: unmatched,
    telemetry,
    errors: [...new Set(errors)],
    healthy: errors.length === 0,
  };
}

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [key, attached] = arg.slice(2).split(/=(.*)/s, 2);
    result[key] = attached ?? argv[index + 1];
    if (attached === undefined) index += 1;
  }
  return result;
}

export function main(argv = process.argv.slice(2)) {
  const opts = options(argv);
  if (!opts.events || !opts['engine-log'] || opts.help) {
    process.stderr.write('Usage: analyze-p20-m0.mjs --events=decklink.csv --engine-log=engine.log [--out=report.json]\n');
    return opts.help ? 0 : 1;
  }
  const report = analyzeP20M0({
    eventRows: parseDecklinkEvents(readFileSync(opts.events, 'utf8')),
    engineLog: readFileSync(opts['engine-log'], 'utf8'),
  });
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (opts.out) writeFileSync(opts.out, output);
  process.stdout.write(output);
  return report.healthy ? 0 : 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`[analyze-p20-m0] ${error.message}\n`);
    process.exitCode = 1;
  }
}
