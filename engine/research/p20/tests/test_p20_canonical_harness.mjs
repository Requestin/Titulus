import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const repoRoot = new URL('../../../..', import.meta.url);
const harness = new URL('../run-p20-cell.sh', import.meta.url);
const channels = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
];

function runDryCell(outDir, extra = []) {
  return execFileSync('bash', [
    harness.pathname,
    '3ch',
    `--channels=${channels.join(',')}`,
    `--out-dir=${outDir}`,
    '--duration=30',
    '--warmup=10',
    '--layered=on',
    '--raster-threads=3',
    ...extra,
  ], {
    cwd: repoRoot.pathname,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

function manifest(outDir, name = 'manifest.json') {
  return JSON.parse(readFileSync(join(outDir, name), 'utf8'));
}

test('canonical 3ch dry-run writes equal channel digests and explicit environment', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'titulus-p20-cell-'));
  runDryCell(outDir);

  const root = manifest(outDir);
  assert.equal(root.schemaVersion, 'p20-canonical-cell-v1');
  assert.equal(root.execution.mode, 'dry_run');
  assert.equal(root.config.mode, '3ch');
  assert.deepEqual(root.config.cpuMasks, ['0,6,1,7', '2,8,3,9', '4,10,5,11']);
  assert.deepEqual(root.config.deviceIndexes, [1, 2, 3]);
  assert.equal(root.config.environment.BG_LAYERED_COMPOSITOR, '1');
  assert.equal(root.config.environment.BG_LAYERED_COMPOSITOR_ALLOWLIST, null);
  assert.equal(root.config.environment.BG_NUM_RASTER_THREADS, '3');
  assert.equal(root.config.url.includes('pacing=1'), true);
  assert.equal(root.config.url.includes('graph=1'), true);
  assert.match(root.configDigest, /^[a-f0-9]{64}$/);

  for (let index = 1; index <= 3; index += 1) {
    const channel = manifest(outDir, `ch${index}/manifest.json`);
    assert.equal(channel.configDigest, root.configDigest);
    assert.equal(channel.execution.mode, 'dry_run');
    assert.equal(channel.channel.index, index);
    assert.equal(channel.channel.cpuMask, root.config.cpuMasks[index - 1]);
    assert.equal(channel.channel.deviceIndex, root.config.deviceIndexes[index - 1]);
    assert.match(channel.plannedCommand.join(' '), /--frame-log=/);
    assert.match(channel.plannedCommand.join(' '), /--decklink-completion-log=/);
  }
});

test('config digest excludes artifact paths and changes for a pacing-relevant flag', () => {
  const first = mkdtempSync(join(tmpdir(), 'titulus-p20-cell-a-'));
  const second = mkdtempSync(join(tmpdir(), 'titulus-p20-cell-b-'));
  const control = mkdtempSync(join(tmpdir(), 'titulus-p20-cell-control-'));
  runDryCell(first);
  runDryCell(second);
  runDryCell(control, ['--layered=off']);

  assert.equal(manifest(first).configDigest, manifest(second).configDigest);
  assert.notEqual(manifest(first).configDigest, manifest(control).configDigest);
});

test('canonical cell rejects an unsafe duplicate CPU assignment before execution', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'titulus-p20-cell-invalid-'));
  assert.throws(
    () => runDryCell(outDir, ['--cpu-masks=0,6,1,7;0,6,1,7;4,10,5,11']),
    /overlap|unsafe/i,
  );
});
