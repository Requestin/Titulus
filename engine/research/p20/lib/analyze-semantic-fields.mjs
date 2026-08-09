#!/usr/bin/env node
/**
 * Offline P20 semantic-field analyser.
 *
 * `analyzeSemanticFields` is pure: callers supply parsed rows and receive a
 * report. File-system and CLI work is kept in `main`, so synthetic capture
 * fixtures exercise the same classifier as a loopback result.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseStrictOptions } from './cli-options.mjs';

const REQUIRED_COLUMNS = [
  'unix_us',
  'output_channel',
  'capture_input',
  'field_index',
  'semantic_id',
  'field_parity',
  'expected_parity',
  'frame_hash',
];

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

function hasColumn(rows, column) {
  return rows.headers?.includes(column) ?? rows.some((row) => Object.hasOwn(row, column));
}

function integer(row, column, source, { allowBlank = false } = {}) {
  const raw = row[column];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    if (allowBlank) return null;
    throw new Error(`${source} is missing ${column}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${source} has invalid ${column}: ${raw}`);
  }
  return value;
}

function string(row, column, source) {
  const value = String(row[column] ?? '').trim();
  if (!value) throw new Error(`${source} is missing ${column}`);
  return value;
}

function assertContract(rows) {
  if (!Array.isArray(rows)) throw new Error('rows must be a parsed CSV row array');
  for (const column of REQUIRED_COLUMNS) {
    if (!hasColumn(rows, column)) throw new Error(`semantic field CSV requires ${column}`);
  }
}

function emptyCounts() {
  return {
    decoded: 0,
    duplicate: 0,
    skipped: 0,
    reversed: 0,
    undecodable: 0,
    parityMismatch: 0,
  };
}

function streamKey(row) {
  return `${string(row, 'output_channel', 'semantic field CSV')}\u0000`
    + string(row, 'capture_input', 'semantic field CSV');
}

function anomaly(kind, row, semanticId, previousSemanticId, semanticDelta) {
  return {
    kind,
    unixUs: integer(row, 'unix_us', 'semantic field CSV'),
    fieldIndex: integer(row, 'field_index', 'semantic field CSV'),
    semanticId,
    previousSemanticId,
    semanticDelta,
    fieldParity: string(row, 'field_parity', 'semantic field CSV'),
    expectedParity: string(row, 'expected_parity', 'semantic field CSV'),
    frameHash: string(row, 'frame_hash', 'semantic field CSV'),
  };
}

/**
 * Classify one capture CSV. `semantic_id` is the monotonically unwrapped
 * value produced by the field decoder; it may use the marker's residue only
 * for extraction, but the analyser intentionally never assumes a wrap size.
 */
export function analyzeSemanticFields(rows) {
  assertContract(rows);
  const streams = new Map();

  for (const row of rows) {
    const key = streamKey(row);
    if (!streams.has(key)) {
      streams.set(key, {
        outputChannel: string(row, 'output_channel', 'semantic field CSV'),
        captureInput: string(row, 'capture_input', 'semantic field CSV'),
        fields: 0,
        counts: emptyCounts(),
        anomalies: [],
        previousFieldIndex: null,
        previousSemanticId: null,
      });
    }
    const stream = streams.get(key);
    const fieldIndex = integer(row, 'field_index', 'semantic field CSV');
    if (stream.previousFieldIndex !== null && fieldIndex <= stream.previousFieldIndex) {
      throw new Error(
        `field_index must strictly increase for ${stream.outputChannel}/${stream.captureInput}`,
      );
    }
    stream.previousFieldIndex = fieldIndex;
    stream.fields += 1;

    const fieldParity = string(row, 'field_parity', 'semantic field CSV');
    const expectedParity = string(row, 'expected_parity', 'semantic field CSV');
    if (fieldParity !== expectedParity) {
      stream.counts.parityMismatch += 1;
      stream.anomalies.push(anomaly(
        'parity_mismatch',
        row,
        integer(row, 'semantic_id', 'semantic field CSV', { allowBlank: true }),
        stream.previousSemanticId,
        null,
      ));
    }

    const semanticId = integer(row, 'semantic_id', 'semantic field CSV', { allowBlank: true });
    if (semanticId === null) {
      stream.counts.undecodable += 1;
      stream.anomalies.push(anomaly(
        'undecodable',
        row,
        null,
        stream.previousSemanticId,
        null,
      ));
      continue;
    }

    stream.counts.decoded += 1;
    if (stream.previousSemanticId !== null) {
      const semanticDelta = semanticId - stream.previousSemanticId;
      if (semanticDelta === 0) {
        stream.counts.duplicate += 1;
        stream.anomalies.push(anomaly(
          'duplicate', row, semanticId, stream.previousSemanticId, semanticDelta,
        ));
      } else if (semanticDelta > 1) {
        stream.counts.skipped += 1;
        stream.anomalies.push(anomaly(
          'skipped', row, semanticId, stream.previousSemanticId, semanticDelta,
        ));
      } else if (semanticDelta < 0) {
        stream.counts.reversed += 1;
        stream.anomalies.push(anomaly(
          'reversed', row, semanticId, stream.previousSemanticId, semanticDelta,
        ));
      }
    }
    stream.previousSemanticId = semanticId;
  }

  const resultStreams = [...streams.values()].map((stream) => ({
    outputChannel: stream.outputChannel,
    captureInput: stream.captureInput,
    fieldRows: stream.fields,
    counts: stream.counts,
    anomalies: stream.anomalies,
    healthy: stream.anomalies.length === 0,
  }));
  const totals = emptyCounts();
  for (const stream of resultStreams) {
    for (const [name, value] of Object.entries(stream.counts)) totals[name] += value;
  }

  return {
    schemaVersion: 'p20-semantic-fields-v1',
    fieldRows: rows.length,
    streams: resultStreams,
    totals,
    healthy: resultStreams.every((stream) => stream.healthy),
  };
}

export function assessSemanticAcceptance(report, { minFields = 1 } = {}) {
  if (!report || typeof report !== 'object') throw new Error('semantic report is required');
  if (!Number.isSafeInteger(minFields) || minFields < 1) {
    throw new Error('minFields must be a positive safe integer');
  }
  const errors = [];
  if (report.fieldRows < minFields) {
    errors.push(report.fieldRows === 0
      ? 'capture has no field rows'
      : `capture has ${report.fieldRows} fields, expected at least ${minFields}`);
  }
  if ((report.totals?.decoded ?? 0) < minFields) {
    errors.push(report.totals?.decoded === 0
      ? 'capture has no decoded fields'
      : `capture has ${report.totals.decoded} decoded fields, expected at least ${minFields}`);
  }
  for (const name of ['duplicate', 'skipped', 'reversed', 'undecodable', 'parityMismatch']) {
    const value = report.totals?.[name] ?? 0;
    if (value !== 0) errors.push(`${name}=${value}`);
  }
  return {
    minFields,
    errors,
    healthy: errors.length === 0,
  };
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseStrictOptions(argv, {
    allowed: new Set(['in', 'out', 'strict', 'min-fields', 'help']),
    boolean: new Set(['strict', 'help']),
  });
  if (!opts.in || opts.help) {
    process.stderr.write(
      'Usage: analyze-semantic-fields.mjs --in=capture-fields.csv '
      + '[--strict] [--min-fields=N] [--out=analysis.json]\n',
    );
    return opts.help ? 0 : 1;
  }
  const report = analyzeSemanticFields(parseCsv(readFileSync(opts.in, 'utf8')));
  const strict = opts.strict !== undefined;
  const minFields = opts['min-fields'] === undefined ? 1 : Number(opts['min-fields']);
  const acceptance = assessSemanticAcceptance(report, { minFields });
  const outputReport = strict ? { ...report, acceptance } : report;
  const output = `${JSON.stringify(outputReport, null, 2)}\n`;
  if (opts.out) writeFileSync(opts.out, output);
  process.stdout.write(output);
  return strict && !acceptance.healthy ? 2 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`[analyze-semantic-fields] ${error.message}\n`);
    process.exitCode = 1;
  }
}
