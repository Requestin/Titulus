#!/usr/bin/env node
/**
 * Offline, observer-only decoder for SDK Capture's 8-bit UYVY 1080i50 dump.
 * It reads every field separately and writes the P20 semantic CSV contract.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  writeFileSync,
} from 'node:fs';

const WIDTH = 1920;
const HEIGHT = 1080;
const FRAME_BYTES = WIDTH * HEIGHT * 2;
const BAR_X = 144;
const BAR_STEP = 24;

function options(argv) {
  const out = {};
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split(/=(.*)/s, 2);
    out[key] = value ?? true;
  }
  return out;
}

function decodeField(frame, parity) {
  let bestX = null;
  let bestHits = 0;
  for (let x = 120; x < 1700; x += 2) {
    let hits = 0;
    for (let y = 180 + parity; y < 900; y += 2) {
      const offset = y * WIDTH * 2 + x * 2;
      const u = frame[offset];
      const y0 = frame[offset + 1];
      const v = frame[offset + 2];
      const y1 = frame[offset + 3];
      // Rec.709 conversion of opaque #00ff7f is high luma with low V.
      if (u >= 75 && u <= 150 && v <= 110 && (y0 >= 110 || y1 >= 110)) hits += 1;
    }
    if (hits > bestHits) {
      bestHits = hits;
      bestX = x;
    }
  }
  if (bestX === null || bestHits < 200) return null;
  const residue = Math.round((bestX - BAR_X) / BAR_STEP);
  if (residue < 0 || residue >= 64 || Math.abs(bestX - (BAR_X + residue * BAR_STEP)) > 3) return null;
  return residue;
}

function hashField(frame, parity) {
  const hash = createHash('sha256');
  const lineBytes = WIDTH * 2;
  for (let y = parity; y < HEIGHT; y += 2) {
    const offset = y * lineBytes;
    hash.update(frame.subarray(offset, offset + lineBytes));
  }
  return hash.digest('hex').slice(0, 16);
}

function safeIntegerOption(value, name, fallback = 0) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return number;
}

function main() {
  const opts = options(process.argv.slice(2));
  if (!opts.in || !opts.out || !opts['output-channel'] || !opts['capture-input']) {
    throw new Error(
      'Usage: decode-uyvy-fields.mjs --in=raw.uyvy --out=capture-fields.csv '
      + '--output-channel=ch1 --capture-input=port6 [--start-unix-us=N] [--tff]',
    );
  }
  const input = openSync(opts.in, 'r');
  const size = fstatSync(input).size;
  if (size === 0 || size % FRAME_BYTES !== 0) {
    closeSync(input);
    throw new Error('input is not a complete 1920x1080 UYVY frame sequence');
  }
  const tff = opts.tff !== undefined;
  const startUnixUs = safeIntegerOption(opts['start-unix-us'], '--start-unix-us');
  const rows = ['unix_us,output_channel,capture_input,field_index,semantic_id,field_parity,expected_parity,frame_hash'];
  let semanticBase = 0;
  let fieldIndex = 0;
  const frameCount = size / FRAME_BYTES;
  const frame = Buffer.allocUnsafe(FRAME_BYTES);
  try {
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      const bytesRead = readSync(input, frame, 0, FRAME_BYTES, frameIndex * FRAME_BYTES);
      if (bytesRead !== FRAME_BYTES) throw new Error(`short read at frame ${frameIndex}`);
      for (const parity of (tff ? [0, 1] : [1, 0])) {
        const residue = decodeField(frame, parity);
        let semanticId = '';
        if (residue !== null) {
          const previous = semanticBase;
          while (semanticBase % 64 !== residue) semanticBase += 1;
          if (semanticBase < previous) throw new Error('semantic unwrap failed');
          semanticId = String(semanticBase);
        }
        rows.push([
          String(startUnixUs + fieldIndex * 20_000),
          opts['output-channel'],
          opts['capture-input'],
          String(fieldIndex),
          semanticId,
          parity === 0 ? 'even' : 'odd',
          parity === 0 ? 'even' : 'odd',
          hashField(frame, parity),
        ].join(','));
        fieldIndex += 1;
      }
    }
  } finally {
    closeSync(input);
  }
  writeFileSync(opts.out, `${rows.join('\n')}\n`, { flag: 'wx' });
}

try {
  main();
} catch (error) {
  process.stderr.write(`[decode-uyvy-fields] ${error.message}\n`);
  process.exitCode = 1;
}
