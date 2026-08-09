import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const decoder = new URL('../decode-uyvy-fields.mjs', import.meta.url);
const width = 1920;
const height = 1080;
const lineBytes = width * 2;

function paintFieldBar(frame, parity, x) {
  for (let y = 180 + parity; y < 900; y += 2) {
    const offset = y * lineBytes + x * 2;
    frame[offset] = 100;
    frame[offset + 1] = 200;
    frame[offset + 2] = 80;
    frame[offset + 3] = 200;
  }
}

test('offline UYVY decoder streams a frame and emits ordered TFF semantic fields', () => {
  const directory = mkdtempSync(join(tmpdir(), 'titulus-p20-uyvy-'));
  const input = join(directory, 'frame.uyvy');
  const output = join(directory, 'fields.csv');
  const frame = Buffer.alloc(width * height * 2);
  paintFieldBar(frame, 0, 144);
  paintFieldBar(frame, 1, 168);
  writeFileSync(input, frame);

  execFileSync(process.execPath, [
    decoder.pathname,
    `--in=${input}`,
    `--out=${output}`,
    '--output-channel=ch1',
    '--capture-input=port6',
    '--start-unix-us=1725000000000000',
    '--tff',
  ]);

  const rows = readFileSync(output, 'utf8').trim().split('\n');
  assert.equal(rows.length, 3);
  assert.match(rows[1], /^1725000000000000,ch1,port6,0,0,even,even,/);
  assert.match(rows[2], /^1725000000020000,ch1,port6,1,1,odd,odd,/);
});
