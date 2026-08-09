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
import { parseStrictOptions } from './cli-options.mjs';

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
      throw new Error(`incomplete DeckLink event row at row ${index + 2}`);
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
    /telemetry in=(\d+) scheduled=(\d+) late=(\d+) dropped=(\d+) flushed=(\d+) overwrite=(\d+) starved=(\d+) pairs=(\d+) singles=(\d+) event_overflow=(\d+)/g,
  )];
  if (matches.length === 0) throw new Error('engine log has no final DeckLink telemetry');
  const match = matches.at(-1);
  return {
    in: Number(match[1]),
    scheduled: Number(match[2]),
    late: Number(match[3]),
    dropped: Number(match[4]),
    flushed: Number(match[5]),
    overwrite: Number(match[6]),
    starved: Number(match[7]),
    pairs: Number(match[8]),
    singles: Number(match[9]),
    eventOverflow: Number(match[10]),
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

function measurementRows(eventRows, measurementStartUnixUs, measurementEndUnixUs) {
  if (measurementStartUnixUs === undefined || measurementStartUnixUs === null) return null;
  if (!Number.isSafeInteger(measurementStartUnixUs) || measurementStartUnixUs < 0) {
    throw new Error('measurementStartUnixUs must be a non-negative safe integer');
  }
  const endUnixUs = measurementEndUnixUs ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(endUnixUs)
      || endUnixUs <= measurementStartUnixUs) {
    throw new Error('measurementEndUnixUs must be greater than measurementStartUnixUs');
  }
  return eventRows.filter((row) => {
    const unixUs = positive(row, 'unix_us');
    return unixUs >= measurementStartUnixUs && unixUs <= endUnixUs;
  });
}

function measurementCadence(eventRows, measurementStartUnixUs, measurementEndUnixUs) {
  if (measurementStartUnixUs === undefined || measurementStartUnixUs === null) {
    return {
      evaluated: false,
      measurementModes: null,
      measurementOverwrites: null,
      errors: [],
      healthy: true,
    };
  }
  const rows = measurementRows(eventRows, measurementStartUnixUs, measurementEndUnixUs);
  const schedules = rows.filter((row) => row.event === 'schedule');
  const measurementModes = { pair: 0, single: 0, starved: 0 };
  for (const schedule of schedules) {
    if (Object.hasOwn(measurementModes, schedule.weave_mode)) {
      measurementModes[schedule.weave_mode] += 1;
    }
  }
  const measurementOverwrites = rows.filter(
    (row) => row.event === 'input_overwrite',
  ).length;
  const errors = [];
  if (schedules.length === 0) errors.push('measurement contains no schedule events');
  if (measurementModes.single > 0) {
    errors.push(`measurement contains single schedule=${measurementModes.single}`);
  }
  if (measurementModes.starved > 0) {
    errors.push(`measurement contains starved schedule=${measurementModes.starved}`);
  }
  if (measurementOverwrites > 0) {
    errors.push(`measurement contains input_overwrite=${measurementOverwrites}`);
  }
  return {
    evaluated: true,
    measurementModes,
    measurementOverwrites,
    errors,
    healthy: errors.length === 0,
  };
}

export function analyzeP20M0({
  eventRows,
  engineLog,
  measurementStartUnixUs,
  measurementEndUnixUs,
}) {
  if (!Array.isArray(eventRows)) throw new Error('eventRows must be a parsed DeckLink event CSV array');
  if (typeof engineLog !== 'string') throw new Error('engineLog must be a string');

  const loggerErrors = [];
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
    if (sourceId === 0) loggerErrors.push('input_overwrite without popped_a source ID');
    if (overwrittenSourceIds.has(sourceId)) {
      loggerErrors.push(`duplicate input_overwrite source_id=${sourceId}`);
    }
    overwrittenSourceIds.add(sourceId);
  }
  const scheduleBySeq = new Map();
  for (const schedule of schedules) {
    const seq = positive(schedule, 'schedule_seq');
    if (scheduleBySeq.has(seq)) loggerErrors.push(`duplicate schedule_seq=${seq}`);
    scheduleBySeq.set(seq, schedule);
  }
  const completed = new Set();
  for (const completion of completions) {
    const seq = positive(completion, 'schedule_seq');
    if (!scheduleBySeq.has(seq)) loggerErrors.push(`completion without schedule_seq=${seq}`);
    if (completed.has(seq)) loggerErrors.push(`duplicate completion for schedule_seq=${seq}`);
    completed.add(seq);
  }

  const scheduleSeqs = [...scheduleBySeq.keys()].sort((left, right) => left - right);
  const unmatched = scheduleSeqs.filter((seq) => !completed.has(seq));
  const firstUnmatched = unmatched[0] ?? null;
  if (firstUnmatched !== null) {
    const expectedTail = scheduleSeqs.slice(scheduleSeqs.indexOf(firstUnmatched));
    if (unmatched.length > 3 || expectedTail.length !== unmatched.length
        || !expectedTail.every((seq, index) => seq === unmatched[index])) {
      for (const seq of unmatched) loggerErrors.push(`missing completion for schedule_seq=${seq}`);
    }
  }
  if (prerollCompletions.length !== 3) {
    loggerErrors.push(`expected 3 preroll completions, got ${prerollCompletions.length}`);
  }
  if (unmatched.length > 0 && !engineLog.includes('duration reached, shutting down')) {
    loggerErrors.push('shutdown tail lacks graceful shutdown marker');
  }

  loggerErrors.push(...validateScheduleSources(schedules));
  const telemetry = finalTelemetry(engineLog);
  const scheduledEventRows = schedules.length + prerollCompletions.length;
  if (telemetry.scheduled !== scheduledEventRows) {
    loggerErrors.push(
      `scheduled telemetry=${telemetry.scheduled} differs from event rows=${scheduledEventRows}`,
    );
  }
  const deliveryErrors = [];
  for (const name of ['late', 'dropped', 'flushed', 'eventOverflow']) {
    const value = telemetry[name];
    if (value !== 0) {
      deliveryErrors.push(`${name === 'eventOverflow' ? 'event_overflow' : name}=${value}`);
    }
  }
  if (telemetry.overwrite !== overwrites.length) {
    loggerErrors.push(
      `overwrite telemetry=${telemetry.overwrite} differs from input_overwrite events=${overwrites.length}`,
    );
  }
  const livenessErrors = [];
  if (telemetry.in === 0) livenessErrors.push('render produced zero frames');
  if (telemetry.pairs === 0) livenessErrors.push('render produced zero complete field pairs');
  const renderLiveness = {
    framesIn: telemetry.in,
    pairs: telemetry.pairs,
    errors: livenessErrors,
    healthy: livenessErrors.length === 0,
  };
  const cadenceHealth = measurementCadence(
    eventRows,
    measurementStartUnixUs,
    measurementEndUnixUs,
  );
  const measuredRows = measurementRows(
    eventRows,
    measurementStartUnixUs,
    measurementEndUnixUs,
  );
  if (measuredRows) {
    const referenceBeforeMeasurement = eventRows.filter(
      (row) => row.event === 'reference_change'
        && positive(row, 'unix_us') <= measurementStartUnixUs,
    ).at(-1);
    if (!referenceBeforeMeasurement) {
      deliveryErrors.push('reference state at measurement start is unknown');
    } else if (positive(referenceBeforeMeasurement, 'reference_state') !== 1) {
      deliveryErrors.push('reference is unlocked at measurement start');
    }
    const unlocks = measuredRows.filter(
      (row) => row.event === 'reference_change' && positive(row, 'reference_state') !== 1,
    );
    if (unlocks.length > 0) deliveryErrors.push(`reference unlock events=${unlocks.length}`);
  }
  const loggerIntegrity = {
    errors: loggerErrors,
    healthy: loggerErrors.length === 0,
  };
  const deliveryHealth = {
    errors: deliveryErrors,
    healthy: deliveryErrors.length === 0,
  };
  const errors = [
    ...loggerErrors,
    ...deliveryErrors,
    ...livenessErrors,
    ...cadenceHealth.errors,
  ];

  return {
    schemaVersion: 'p20-m0-v1',
    schedules: schedules.length,
    completions: completions.length,
    prerollCompletions: prerollCompletions.length,
    inputOverwrites: overwrites.length,
    shutdownTail: unmatched,
    telemetry,
    loggerIntegrity,
    deliveryHealth,
    renderLiveness,
    cadenceHealth,
    errors: [...new Set(errors)],
    healthy: errors.length === 0,
  };
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseStrictOptions(argv, {
    allowed: new Set([
      'events',
      'engine-log',
      'measurement-start-unix-us',
      'measurement-end-unix-us',
      'out',
      'help',
    ]),
    boolean: new Set(['help']),
  });
  if (!opts.events || !opts['engine-log'] || opts.help) {
    process.stderr.write(
      'Usage: analyze-p20-m0.mjs --events=decklink.csv --engine-log=engine.log '
      + '[--measurement-start-unix-us=N --measurement-end-unix-us=N] '
      + '[--out=report.json]\n',
    );
    return opts.help ? 0 : 1;
  }
  const measurementStartUnixUs = opts['measurement-start-unix-us'] === undefined
    ? undefined
    : Number(opts['measurement-start-unix-us']);
  const measurementEndUnixUs = opts['measurement-end-unix-us'] === undefined
    ? undefined
    : Number(opts['measurement-end-unix-us']);
  const report = analyzeP20M0({
    eventRows: parseDecklinkEvents(readFileSync(opts.events, 'utf8')),
    engineLog: readFileSync(opts['engine-log'], 'utf8'),
    measurementStartUnixUs,
    measurementEndUnixUs,
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
