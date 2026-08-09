#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  analyzeP20M0,
  parseDecklinkEvents,
} from './analyze-p20-m0.mjs';
import {
  analyzeSemanticFields,
  assessSemanticAcceptance,
  parseCsv,
} from './analyze-semantic-fields.mjs';

function sequenceRange(rows, column) {
  const values = rows.map((row) => Number(row[column])).filter(Number.isFinite);
  if (values.length === 0) return null;
  return { first: values[0], last: values.at(-1), delta: values.at(-1) - values[0] };
}

function assessFrameLiveness(frameRows) {
  const errors = [];
  if (!Array.isArray(frameRows) || frameRows.length === 0) {
    errors.push('frame log has no measurement rows');
  }
  const cefPaint = sequenceRange(frameRows ?? [], 'cef_paint_after');
  const publish = sequenceRange(frameRows ?? [], 'publish_seq_after');
  const logicalFrame = sequenceRange(frameRows ?? [], 'logical_frame_after');
  if (!cefPaint || cefPaint.delta <= 0) errors.push('CEF paint sequence did not advance');
  if (!publish || publish.delta <= 0) errors.push('publish sequence did not advance');
  if (!logicalFrame || logicalFrame.delta <= 0) errors.push('logical frame sequence did not advance');
  return {
    rows: frameRows?.length ?? 0,
    cefPaint,
    publish,
    logicalFrame,
    errors,
    healthy: errors.length === 0,
  };
}

export function analyzeP20Evidence({
  m0Report,
  semanticReport,
  frameRows,
  minFields = 1,
}) {
  if (!m0Report || typeof m0Report !== 'object') throw new Error('m0Report is required');
  const semantic = assessSemanticAcceptance(semanticReport, { minFields });
  const frameLiveness = assessFrameLiveness(frameRows);
  const logger = m0Report.loggerIntegrity ?? {
    errors: [...(m0Report.errors ?? [])],
    healthy: m0Report.healthy === true,
  };
  const delivery = m0Report.deliveryHealth ?? {
    errors: [...(m0Report.errors ?? [])],
    healthy: m0Report.healthy === true,
  };
  const producer = m0Report.renderLiveness ?? {
    errors: [],
    healthy: m0Report.healthy === true,
  };
  const decklinkCadence = m0Report.cadenceHealth ?? {
    errors: [],
    healthy: m0Report.healthy === true,
  };
  const errors = [
    ...(m0Report.errors ?? []),
    ...semantic.errors,
    ...frameLiveness.errors,
  ];
  return {
    schemaVersion: 'p20-joint-evidence-v1',
    planes: {
      logger,
      delivery,
      producer,
      decklinkCadence,
      semantic,
      frameLiveness,
    },
    errors: [...new Set(errors)],
    healthy: logger.healthy
      && delivery.healthy
      && producer.healthy
      && decklinkCadence.healthy
      && semantic.healthy
      && frameLiveness.healthy,
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

function frameRowsInMeasurement(rows, measurement) {
  if (!measurement) return rows;
  return rows.filter((row) => {
    const unixUs = Number(row.unix_us);
    return Number.isFinite(unixUs)
      && unixUs >= measurement.startUnixUs
      && unixUs <= measurement.endUnixUs;
  });
}

export function main(argv = process.argv.slice(2)) {
  const opts = options(argv);
  if (!opts['run-dir'] || !opts.capture || opts.help) {
    process.stderr.write(
      'Usage: analyze-p20-evidence.mjs --run-dir=DIR --capture=fields.csv '
      + '[--channel=N] [--min-fields=N] [--out=report.json]\n',
    );
    return opts.help ? 0 : 1;
  }
  const channel = Number(opts.channel ?? 1);
  if (!Number.isSafeInteger(channel) || channel < 1) {
    throw new Error('--channel must be a positive integer');
  }
  const runDir = opts['run-dir'];
  const channelDir = join(runDir, `ch${channel}`);
  const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'));
  const measurementStartUnixUs = manifest.measurement?.startUnixUs;
  const m0Report = analyzeP20M0({
    eventRows: parseDecklinkEvents(readFileSync(join(channelDir, 'decklink-completion.csv'), 'utf8')),
    engineLog: readFileSync(join(channelDir, 'engine.log'), 'utf8'),
    measurementStartUnixUs,
  });
  const semanticReport = analyzeSemanticFields(parseCsv(readFileSync(opts.capture, 'utf8')));
  const allFrameRows = parseCsv(readFileSync(join(channelDir, 'frame.csv'), 'utf8'));
  const report = analyzeP20Evidence({
    m0Report,
    semanticReport,
    frameRows: frameRowsInMeasurement(allFrameRows, manifest.measurement),
    minFields: Number(opts['min-fields'] ?? 1),
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
    process.stderr.write(`[analyze-p20-evidence] ${error.message}\n`);
    process.exitCode = 1;
  }
}
