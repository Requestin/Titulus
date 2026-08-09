#!/usr/bin/env node
/**
 * P20.1 microfreeze detector.
 *
 * Intervals and clusters are calculated only from mono_us. unix_us is used
 * only to correlate an already-detected cluster with external evidence.
 *
 * Usage:
 *   node engine/research/lib/analyze-microfreeze.mjs --frame=frame.csv \
 *     [--marks=marks.csv] [--completion=completion.csv] [--gc=gc.csv] \
 *     [--scheduler=scheduler.csv] [--out=report.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOFT_HITCH_US = 30_000;
const MICROFREEZE_US = 50_000;
const HARD_FREEZE_US = 100_000;
const SEMANTIC_GAP_HARD = 3;
const CLUSTER_US = 200_000;
const WINDOWS_US = {
  marks: 700_000,
  completions: 40_000,
  gc: 100_000,
  scheduler: 50_000,
};
const SEMANTIC_COLUMNS = ['semantic_seq', 'semantic_id', 'field_id', 'logical_frame_after'];

/**
 * Parse a header-aware CSV without assuming a fixed column order. It supports
 * RFC 4180-style quoted cells, including doubled quotes.
 */
export function parseCsv(text) {
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
      continue;
    }
    if (character === '"') {
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

  if (quoted) throw new Error('CSV contains an unterminated quoted cell');
  if (field.length > 0 || record.length > 0) {
    record.push(field.replace(/\r$/, ''));
    if (record.some((cell) => cell.length > 0)) records.push(record);
  }
  if (records.length === 0) throw new Error('CSV is empty or has no header');

  const headers = records.shift().map((header, index) => (
    index === 0 ? header.replace(/^\uFEFF/, '').trim() : header.trim()
  ));
  if (headers.some((header) => header.length === 0)) throw new Error('CSV has an empty header');
  if (new Set(headers).size !== headers.length) throw new Error('CSV has duplicate headers');

  const rows = records.map((cells, lineIndex) => {
    if (cells.length > headers.length) {
      throw new Error(`CSV row ${lineIndex + 2} has more fields than its header`);
    }
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
  });
  Object.defineProperty(rows, 'headers', { value: headers, enumerable: false });
  return rows;
}

function hasColumn(rows, name) {
  return rows.headers?.includes(name) ?? rows.some((row) => Object.hasOwn(row, name));
}

function numberAt(row, column, source) {
  const raw = row[column];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new Error(`${source} row is missing ${column}`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${source} has invalid ${column}: ${raw}`);
  }
  return value;
}

function assertFrameColumns(frameRows, joinsRequested) {
  if (!hasColumn(frameRows, 'mono_us')) {
    throw new Error(
      'frame CSV requires mono_us for intervals; legacy steady wall_clock_us is not a safe timestamp source',
    );
  }
  if (!hasColumn(frameRows, 'interval_us')) {
    throw new Error('frame CSV requires interval_us');
  }
  if (joinsRequested && !hasColumn(frameRows, 'unix_us')) {
    throw new Error('frame CSV requires unix_us before external joins can be performed');
  }
}

function semanticValue(row) {
  const column = SEMANTIC_COLUMNS.find((candidate) => (
    row[candidate] !== undefined && String(row[candidate]).trim() !== ''
  ));
  return column ? numberAt(row, column, 'frame CSV') : null;
}

function severity(intervalUs, semanticGap) {
  if (intervalUs >= HARD_FREEZE_US || semanticGap >= SEMANTIC_GAP_HARD) return 'hard';
  if (intervalUs >= MICROFREEZE_US) return 'micro';
  if (intervalUs >= SOFT_HITCH_US) return 'soft';
  return null;
}

function severityRank(value) {
  return { soft: 1, micro: 2, hard: 3 }[value] ?? 0;
}

function normaliseExternalRows(rows, source) {
  if (rows === undefined) return [];
  if (!hasColumn(rows, 'unix_us')) throw new Error(`${source} CSV requires unix_us for correlation`);
  return rows.map((row) => ({
    unixUs: numberAt(row, 'unix_us', source),
    event: row.event ?? '',
    row,
  })).sort((left, right) => left.unixUs - right.unixUs);
}

function makeEvents(frameRows, joinsRequested) {
  const frames = frameRows.map((row, index) => ({
    row,
    index,
    monoUs: numberAt(row, 'mono_us', 'frame CSV'),
    unixUs: joinsRequested ? numberAt(row, 'unix_us', 'frame CSV') : null,
    intervalUs: numberAt(row, 'interval_us', 'frame CSV'),
    semantic: semanticValue(row),
  })).sort((left, right) => left.monoUs - right.monoUs);

  let previousMonoUs = -1;
  let previousSemantic = null;
  const events = [];
  for (const frame of frames) {
    if (frame.monoUs < previousMonoUs) {
      throw new Error('frame CSV mono_us must be non-decreasing');
    }
    const semanticGap = previousSemantic === null || frame.semantic === null
      ? 0
      : frame.semantic - previousSemantic;
    const eventSeverity = severity(frame.intervalUs, semanticGap);
    if (eventSeverity) {
      const reasons = [];
      if (frame.intervalUs >= HARD_FREEZE_US) reasons.push('interval_hard');
      else if (frame.intervalUs >= MICROFREEZE_US) reasons.push('interval_micro');
      else if (frame.intervalUs >= SOFT_HITCH_US) reasons.push('interval_soft');
      if (semanticGap >= SEMANTIC_GAP_HARD) reasons.push('semantic_gap');
      events.push({
        frameIndex: frame.index,
        monoUs: frame.monoUs,
        unixUs: frame.unixUs,
        intervalUs: frame.intervalUs,
        semanticGap,
        severity: eventSeverity,
        reasons,
        classification: 'isolated',
      });
    }
    previousMonoUs = frame.monoUs;
    previousSemantic = frame.semantic ?? previousSemantic;
  }
  return { frames, events };
}

function classifyAlternatingBursts(frames, events) {
  const eventByFrameIndex = new Map(events.map((event) => [event.frameIndex, event]));
  const candidates = [];
  for (const event of events) {
    const next = frames.find((frame) => frame.index === event.frameIndex + 1);
    if (
      event.intervalUs >= SOFT_HITCH_US
      && event.intervalUs < HARD_FREEZE_US
      && event.semanticGap < SEMANTIC_GAP_HARD
      && next
      && next.intervalUs <= 25_000
    ) {
      candidates.push(event);
    }
  }

  const bursts = [];
  let run = [];
  for (const candidate of candidates) {
    const previous = run.at(-1);
    const isContinuation = previous
      && candidate.frameIndex === previous.frameIndex + 2
      && candidate.monoUs - previous.monoUs <= 100_000;
    if (!previous || isContinuation) {
      run.push(candidate);
    } else {
      if (run.length >= 3) bursts.push(run);
      run = [candidate];
    }
  }
  if (run.length >= 3) bursts.push(run);

  return bursts.map((burst, burstIndex) => {
    for (const event of burst) {
      event.classification = 'systematic_alternating_burst';
      event.alternatingBurst = burstIndex + 1;
    }
    return {
      id: burstIndex + 1,
      eventCount: burst.length,
      startMonoUs: burst[0].monoUs,
      endMonoUs: burst.at(-1).monoUs,
      startUnixUs: burst[0].unixUs,
      endUnixUs: burst.at(-1).unixUs,
      eventFrameIndexes: burst.map((event) => event.frameIndex),
    };
  });
}

function clusterEvents(events, external) {
  const clusters = [];
  for (const event of events) {
    const cluster = clusters.at(-1);
    if (!cluster || event.monoUs - cluster.endMonoUs > CLUSTER_US) {
      clusters.push({
        startMonoUs: event.monoUs,
        endMonoUs: event.monoUs,
        events: [event],
      });
    } else {
      cluster.endMonoUs = event.monoUs;
      cluster.events.push(event);
    }
  }

  return clusters.map((cluster, index) => {
    const reference = cluster.events.reduce((best, event) => (
      severityRank(event.severity) > severityRank(best.severity)
      || (severityRank(event.severity) === severityRank(best.severity) && event.intervalUs > best.intervalUs)
        ? event
        : best
    ));
    const classifications = new Set(cluster.events.map((event) => event.classification));
    const join = (rows, windowUs) => reference.unixUs === null
      ? []
      : rows.filter((row) => Math.abs(row.unixUs - reference.unixUs) <= windowUs);
    return {
      id: index + 1,
      classification: classifications.size === 1 ? [...classifications][0] : 'mixed',
      severity: cluster.events.reduce((best, event) => (
        severityRank(event.severity) > severityRank(best) ? event.severity : best
      ), 'soft'),
      startMonoUs: cluster.startMonoUs,
      endMonoUs: cluster.endMonoUs,
      referenceMonoUs: reference.monoUs,
      referenceUnixUs: reference.unixUs,
      maxIntervalUs: Math.max(...cluster.events.map((event) => event.intervalUs)),
      reasons: [...new Set(cluster.events.flatMap((event) => event.reasons))],
      events: cluster.events,
      joins: {
        freezeMarks: join(external.marks.filter((row) => row.event.toLowerCase() === 'freeze'), WINDOWS_US.marks),
        controlMarks: join(external.marks.filter((row) => row.event.toLowerCase() === 'control'), WINDOWS_US.marks),
        completions: join(external.completions, WINDOWS_US.completions),
        gc: join(external.gc, WINDOWS_US.gc),
        scheduler: join(external.scheduler, WINDOWS_US.scheduler),
      },
    };
  });
}

function markMetrics(marks, clusters) {
  const matchesCluster = (mark) => clusters.some((cluster) => (
    cluster.referenceUnixUs !== null
    && Math.abs(mark.unixUs - cluster.referenceUnixUs) <= WINDOWS_US.marks
  ));
  const calculate = (event, rateName) => {
    const relevant = marks.filter((mark) => mark.event.toLowerCase() === event);
    const matched = relevant.filter(matchesCluster).length;
    return {
      total: relevant.length,
      matched,
      [rateName]: relevant.length ? Number((matched / relevant.length).toFixed(4)) : null,
    };
  };
  return {
    freeze: calculate('freeze', 'matchRate'),
    control: calculate('control', 'falsePositiveRate'),
  };
}

/**
 * Analyze already-parsed P20 CSV rows. The function is importable for tests
 * and tools; CLI I/O is deliberately kept below.
 */
export function analyzeMicrofreeze({
  frameRows,
  markRows,
  completionRows,
  gcRows,
  schedulerRows,
}) {
  if (!Array.isArray(frameRows)) throw new Error('frameRows must be a parsed CSV row array');
  const joinsRequested = [markRows, completionRows, gcRows, schedulerRows].some((rows) => rows !== undefined);
  assertFrameColumns(frameRows, joinsRequested);
  const external = {
    marks: normaliseExternalRows(markRows, 'marks'),
    completions: normaliseExternalRows(completionRows, 'completion'),
    gc: normaliseExternalRows(gcRows, 'gc'),
    scheduler: normaliseExternalRows(schedulerRows, 'scheduler'),
  };
  const { frames, events } = makeEvents(frameRows, joinsRequested);
  const systematicAlternatingBursts = classifyAlternatingBursts(frames, events);
  const clusters = clusterEvents(events, external);
  const operatorMarks = markMetrics(external.marks, clusters);
  const eventCounts = { soft: 0, micro: 0, hard: 0 };
  for (const event of events) eventCounts[event.severity] += 1;

  return {
    schemaVersion: 'p20.1',
    frameRows: frameRows.length,
    thresholdsUs: {
      softHitch: SOFT_HITCH_US,
      microfreeze: MICROFREEZE_US,
      hardFreeze: HARD_FREEZE_US,
      semanticGapHard: SEMANTIC_GAP_HARD,
      cluster: CLUSTER_US,
    },
    joinWindowsUs: WINDOWS_US,
    eventCounts,
    systematicAlternatingBursts,
    clusters,
    metrics: {
      operatorMarks,
      freezeMarkMatchRate: operatorMarks.freeze.matchRate,
      controlMarkFalsePositiveRate: operatorMarks.control.falsePositiveRate,
      isolatedMicrofreezeClusters: clusters.filter((cluster) => (
        cluster.classification === 'isolated' && severityRank(cluster.severity) >= severityRank('micro')
      )).length,
    },
  };
}

function args(argv) {
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

function loadCsv(path) {
  return parseCsv(readFileSync(path, 'utf8'));
}

export function main(argv = process.argv.slice(2)) {
  const options = args(argv);
  if (!options.frame || options.help) {
    console.error(
      'Usage: analyze-microfreeze.mjs --frame=frame.csv [--marks=marks.csv] ' +
      '[--completion=completion.csv] [--gc=gc.csv] [--scheduler=scheduler.csv] [--out=report.json]',
    );
    return 1;
  }
  const report = analyzeMicrofreeze({
    frameRows: loadCsv(options.frame),
    markRows: options.marks ? loadCsv(options.marks) : undefined,
    completionRows: options.completion ? loadCsv(options.completion) : undefined,
    gcRows: options.gc ? loadCsv(options.gc) : undefined,
    schedulerRows: options.scheduler ? loadCsv(options.scheduler) : undefined,
  });
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) writeFileSync(options.out, output);
  process.stdout.write(output);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[analyze-microfreeze] ${error.message}`);
    process.exitCode = 1;
  }
}
