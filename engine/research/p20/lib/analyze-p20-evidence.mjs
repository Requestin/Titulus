#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseStrictOptions } from './cli-options.mjs';

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
  metadataReport = { errors: [], healthy: true },
  captureBinding = { errors: [], healthy: true },
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
    ...metadataReport.errors,
    ...captureBinding.errors,
    ...(m0Report.errors ?? []),
    ...semantic.errors,
    ...frameLiveness.errors,
  ];
  return {
    schemaVersion: 'p20-joint-evidence-v1',
    planes: {
      metadata: metadataReport,
      captureBinding,
      logger,
      delivery,
      producer,
      decklinkCadence,
      semantic,
      frameLiveness,
    },
    errors: [...new Set(errors)],
    healthy: metadataReport.healthy
      && captureBinding.healthy
      && logger.healthy
      && delivery.healthy
      && producer.healthy
      && decklinkCadence.healthy
      && semantic.healthy
      && frameLiveness.healthy,
  };
}

export function validateRunMetadata({ manifest, channelManifest, runStatus }) {
  const errors = [];
  if (manifest?.execution?.mode !== 'execute') errors.push('run execution mode is not execute');
  if (runStatus?.outcome !== 'completed') errors.push('run outcome is not completed');
  const startUnixUs = manifest?.measurement?.startUnixUs;
  const endUnixUs = manifest?.measurement?.endUnixUs;
  if (!Number.isSafeInteger(startUnixUs) || !Number.isSafeInteger(endUnixUs)
      || endUnixUs <= startUnixUs) {
    errors.push('run measurement window is invalid');
  }
  if (typeof manifest?.configDigest !== 'string' || manifest.configDigest.length === 0) {
    errors.push('root manifest config digest is missing');
  } else if (channelManifest?.configDigest !== manifest.configDigest) {
    errors.push('channel manifest config digest differs from root manifest');
  }
  return { errors, healthy: errors.length === 0 };
}

export function validateCaptureBinding(rows, {
  measurement,
  outputChannel,
  captureInput,
}) {
  const errors = [];
  if (!Array.isArray(rows) || rows.length === 0) errors.push('capture has no rows');
  const streams = new Set();
  let firstUnixUs = Number.POSITIVE_INFINITY;
  let lastUnixUs = 0;
  for (const row of rows ?? []) {
    const output = String(row.output_channel ?? '');
    const input = String(row.capture_input ?? '');
    streams.add(`${output}\0${input}`);
    if (output !== outputChannel || input !== captureInput) {
      errors.push(`capture stream ${output}/${input} differs from expected ${outputChannel}/${captureInput}`);
    }
    const unixUs = Number(row.unix_us);
    if (!Number.isSafeInteger(unixUs)) {
      errors.push('capture row has invalid unix_us');
      continue;
    }
    firstUnixUs = Math.min(firstUnixUs, unixUs);
    lastUnixUs = Math.max(lastUnixUs, unixUs);
    if (unixUs < measurement.startUnixUs || unixUs > measurement.endUnixUs) {
      errors.push(`capture timestamp ${unixUs} is outside measurement window`);
    }
  }
  if (streams.size !== 1) errors.push(`capture contains ${streams.size} streams, expected exactly one`);
  return {
    outputChannel,
    captureInput,
    firstUnixUs: Number.isFinite(firstUnixUs) ? firstUnixUs : null,
    lastUnixUs: lastUnixUs || null,
    errors: [...new Set(errors)],
    healthy: errors.length === 0,
  };
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
  const opts = parseStrictOptions(argv, {
    allowed: new Set([
      'run-dir',
      'capture',
      'channel',
      'output-channel',
      'capture-input',
      'min-fields',
      'out',
      'help',
    ]),
    boolean: new Set(['help']),
  });
  if (!opts['run-dir'] || !opts.capture || !opts['output-channel']
      || !opts['capture-input'] || opts.help) {
    process.stderr.write(
      'Usage: analyze-p20-evidence.mjs --run-dir=DIR --capture=fields.csv '
      + '--output-channel=TOKEN --capture-input=TOKEN '
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
  const channelManifest = JSON.parse(readFileSync(join(channelDir, 'manifest.json'), 'utf8'));
  const runStatus = JSON.parse(readFileSync(join(runDir, 'run-status.json'), 'utf8'));
  const metadataReport = validateRunMetadata({ manifest, channelManifest, runStatus });
  const measurementStartUnixUs = manifest.measurement?.startUnixUs;
  const m0Report = analyzeP20M0({
    eventRows: parseDecklinkEvents(readFileSync(join(channelDir, 'decklink-completion.csv'), 'utf8')),
    engineLog: readFileSync(join(channelDir, 'engine.log'), 'utf8'),
    measurementStartUnixUs,
    measurementEndUnixUs: manifest.measurement?.endUnixUs,
  });
  const captureText = readFileSync(opts.capture, 'utf8');
  const captureRows = parseCsv(captureText);
  const captureBinding = validateCaptureBinding(captureRows, {
    measurement: manifest.measurement,
    outputChannel: opts['output-channel'],
    captureInput: opts['capture-input'],
  });
  const semanticReport = analyzeSemanticFields(captureRows);
  const allFrameRows = parseCsv(readFileSync(join(channelDir, 'frame.csv'), 'utf8'));
  const report = analyzeP20Evidence({
    m0Report,
    semanticReport,
    frameRows: frameRowsInMeasurement(allFrameRows, manifest.measurement),
    minFields: Number(opts['min-fields'] ?? 1),
    metadataReport,
    captureBinding,
  });
  report.capture = {
    sha256: createHash('sha256').update(captureText).digest('hex'),
    path: opts.capture,
  };
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
