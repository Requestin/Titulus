import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const runChannel = new URL('../engine/run-channel.sh', import.meta.url);
const devStart = new URL('../dev-start.sh', import.meta.url);
const devStop = new URL('../dev-stop.sh', import.meta.url);

function dryRun(outputMode, env = {}) {
  return execFileSync(
    'bash',
    [
      runChannel.pathname,
      '--id=11111111-1111-4111-8111-111111111111',
      '--name=Test Channel',
      `--output-mode=${outputMode}`,
      '--device-index=1',
      '--display-mode=HD1080i50',
      '--keyer=fill_only',
      '--cores=0-3',
      '--dry-run',
    ],
    {
      cwd: root.pathname,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    },
  );
}

test('decklink channel dry run propagates one_tick to channel.html', () => {
  const output = dryRun('decklink', { TITULUS_PACING_MODE: 'one_tick' });

  assert.match(output, /pacing_mode=one_tick/);
});

test('browser channel dry run does not change its pacing URL', () => {
  const output = dryRun('browser', { TITULUS_PACING_MODE: 'one_tick' });

  assert.doesNotMatch(output, /pacing_mode=one_tick/);
});

test('dev start defaults DeckLink engines to one_tick', () => {
  const source = readFileSync(devStart, 'utf8');

  assert.match(source, /TITULUS_DEV_PACING_MODE:-one_tick/);
  assert.match(source, /TITULUS_PACING_MODE="\$DEV_PACING_MODE"/);
});

test('dev engine supervisor runs in an isolated process group', () => {
  const source = readFileSync(devStart, 'utf8');

  assert.match(source, /setsid env BACKEND_URL=/);
});

test('dev stop terminates and waits for the engine process group', () => {
  const source = readFileSync(devStop, 'utf8');

  assert.match(source, /kill -TERM -- "-\$pid"/);
  assert.match(source, /wait_for_engine_shutdown/);
});
