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

function runDryOneCell(outDir, extra = []) {
  return execFileSync('bash', [
    harness.pathname,
    '1ch',
    '--channels=00000000-0000-4000-8000-000000000001',
    `--out-dir=${outDir}`,
    '--duration=30',
    '--warmup=10',
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
  assert.equal(root.config.pacingMode, 'accumulator');
  assert.equal(root.config.provenance, 'on');
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
    assert.equal(channel.plannedCommand.includes('--duration=100'), true);
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

test('one-tick P20.3 cell is explicit in its digest and engine URL', () => {
  const baseline = mkdtempSync(join(tmpdir(), 'titulus-p20-cell-accumulator-'));
  const oneTick = mkdtempSync(join(tmpdir(), 'titulus-p20-cell-one-tick-'));
  runDryCell(baseline);
  runDryCell(oneTick, ['--pacing-mode=one-tick']);

  const manifestOneTick = manifest(oneTick);
  assert.equal(manifestOneTick.config.pacingMode, 'one_tick');
  assert.match(manifestOneTick.config.url, /pacing_mode=one_tick/);
  assert.notEqual(manifest(baseline).configDigest, manifestOneTick.configDigest);
});

test('token-armed CEF wait is opt-in and changes the canonical digest', () => {
  const baseline = mkdtempSync(join(tmpdir(), 'titulus-p20-cell-wait-control-'));
  const treatment = mkdtempSync(join(tmpdir(), 'titulus-p20-cell-wait-treatment-'));
  runDryOneCell(baseline, ['--pacing-mode=one-tick']);
  runDryOneCell(treatment, ['--pacing-mode=one-tick', '--token-armed-wait']);

  const treatmentRoot = manifest(treatment);
  const command = manifest(treatment, 'ch1/manifest.json').plannedCommand.join(' ');
  assert.equal(manifest(baseline).config.tokenArmedWait, false);
  assert.equal(treatmentRoot.config.tokenArmedWait, true);
  assert.match(command, /--decklink-token-armed-wait/);
  assert.notEqual(manifest(baseline).configDigest, treatmentRoot.configDigest);
});

test('absolute field grid is opt-in and changes canonical engine command', () => {
  const control = mkdtempSync(join(tmpdir(), 'titulus-p20-cell-grid-control-'));
  const treatment = mkdtempSync(join(tmpdir(), 'titulus-p20-cell-grid-treatment-'));
  runDryOneCell(control, ['--pacing-mode=one-tick', '--token-armed-wait']);
  runDryOneCell(treatment, [
    '--pacing-mode=one-tick',
    '--token-armed-wait',
    '--absolute-field-grid',
  ]);

  const root = manifest(treatment);
  const command = manifest(treatment, 'ch1/manifest.json').plannedCommand.join(' ');
  assert.equal(manifest(control).config.absoluteFieldGrid, false);
  assert.equal(root.config.absoluteFieldGrid, true);
  assert.match(command, /--decklink-absolute-field-grid/);
  assert.notEqual(manifest(control).configDigest, root.configDigest);
});

test('absolute field grid rejects an invalid stacked treatment', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'titulus-p20-cell-grid-invalid-'));
  assert.throws(
    () => runDryOneCell(outDir, ['--absolute-field-grid']),
    /requires --token-armed-wait/i,
  );
});

test('one-pair reservoir is opt-in and excludes absolute field grid', () => {
  const treatment = mkdtempSync(join(tmpdir(), 'titulus-p20-cell-reservoir-'));
  runDryOneCell(treatment, [
    '--pacing-mode=one-tick',
    '--token-armed-wait',
    '--one-pair-reservoir',
  ]);

  const root = manifest(treatment);
  const command = manifest(treatment, 'ch1/manifest.json').plannedCommand.join(' ');
  assert.equal(root.config.onePairReservoir, true);
  assert.match(command, /--decklink-one-pair-reservoir/);
  assert.throws(
    () => runDryOneCell(
      mkdtempSync(join(tmpdir(), 'titulus-p20-cell-reservoir-invalid-')),
      ['--token-armed-wait', '--absolute-field-grid', '--one-pair-reservoir'],
    ),
    /cannot be combined/i,
  );
});

test('null M2 cell excludes DeckLink-only hardware and pacing flags', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'titulus-p20-cell-null-m2-'));
  runDryOneCell(outDir, [
    '--consumer=null',
    '--pacing-mode=one-tick',
    '--provenance=on',
  ]);

  const root = manifest(outDir);
  const command = manifest(outDir, 'ch1/manifest.json').plannedCommand.join(' ');
  assert.equal(root.config.consumer, 'null');
  assert.equal(root.execution.decklinkArmed, false);
  assert.match(command, /--consumer=null/);
  assert.doesNotMatch(command, /--device-index=|--display-mode=|--decklink-completion-log=|--decklink-token-armed-wait/);
});

test('null M2 cell rejects a DeckLink-only token wait', () => {
  assert.throws(
    () => runDryOneCell(
      mkdtempSync(join(tmpdir(), 'titulus-p20-cell-null-invalid-')),
      ['--consumer=null', '--token-armed-wait'],
    ),
    /require.*--consumer=decklink/i,
  );
});

test('null execution does not evaluate the consumer name arithmetically', () => {
  const source = readFileSync(harness, 'utf8');
  assert.match(
    source,
    /if \(\( EXECUTE == 1 \)\) && \[\[ "\$CONSUMER" == "decklink" \]\]/,
  );
});

test('complex test1 marker path and digest are explicit in canonical manifest', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'titulus-p20-cell-test1-marker-'));
  runDryOneCell(outDir, [
    `--template=${new URL('../../../../tests/templates/p20-test1-marker.json', import.meta.url).pathname}`,
  ]);
  assert.equal(manifest(outDir).config.template.path, 'tests/templates/p20-test1-marker.json');
});

test('integrated 1ch loopback capture is bound to canonical run identity', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'titulus-p20-cell-loopback-'));
  runDryOneCell(outDir, [
    '--loopback-capture-bin=/bin/true',
    '--loopback-input-device=2',
    '--loopback-output-channel=ch1',
    '--loopback-capture-input=quad2-sdi6',
  ]);
  const root = manifest(outDir);
  assert.deepEqual(root.config.loopback, {
    inputDeviceIndex: 2,
    outputChannel: 'ch1',
    captureInput: 'quad2-sdi6',
  });
  assert.match(root.plannedCaptureCommand.join(' '), new RegExp(`--run-id=${root.runId}`));
  assert.match(root.plannedCaptureCommand.join(' '), new RegExp(`--config-digest=${root.configDigest}`));
});

test('P20.1 provenance-off baseline keeps the common performance recorder only', () => {
  const off = mkdtempSync(join(tmpdir(), 'titulus-p20-cell-provenance-off-'));
  runDryCell(off, ['--provenance=off']);

  const root = manifest(off);
  const channel = manifest(off, 'ch1/manifest.json');
  assert.equal(root.config.provenance, 'off');
  assert.match(root.config.url, /pacing=0/);
  assert.match(channel.plannedCommand.join(' '), /--frame-log=/);
  assert.doesNotMatch(channel.plannedCommand.join(' '), /--decklink-completion-log=/);
});

test('canonical 1ch defaults to the first physical-safe map entry', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'titulus-p20-cell-one-channel-'));
  runDryOneCell(outDir);

  const root = manifest(outDir);
  assert.deepEqual(root.config.cpuMasks, ['0,6,1,7']);
  assert.deepEqual(root.config.deviceIndexes, [1]);
  assert.deepEqual(root.config.startOffsetsMs, [0]);
});

test('canonical cell records a host-derived CPU plan instead of a Ryzen-only allowlist', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'titulus-p20-cell-cpu-plan-'));
  runDryCell(outDir);

  const root = manifest(outDir);
  assert.equal(root.config.cpuCoreClass, 'auto');
  assert.equal(root.config.cpuPlan.channels.length, 3);
  assert.deepEqual(
    root.config.cpuPlan.channels.map((channel) => channel.cpus),
    root.config.cpuMasks,
  );
  assert.equal(root.host.kernel.length > 0, true);
  assert.match(root.host.lscpuSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(readFileSync(harness, 'utf8'), /SAFE_MASKS=/);
});

test('DeckLink readiness accepts a locked reference reported in telemetry', () => {
  const source = readFileSync(harness, 'utf8');
  assert.match(source, /started mode=HD1080i50.*low_latency=yes/);
  assert.match(source, /ref=locked/);
});

test('canonical cell rejects an unsafe duplicate CPU assignment before execution', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'titulus-p20-cell-invalid-'));
  assert.throws(
    () => runDryCell(outDir, ['--cpu-masks=0,6,1,7;0,6,1,7;4,10,5,11']),
    /overlap|unsafe/i,
  );
});

test('canonical harness has bounded process-group cleanup and records aborted runs', () => {
  const source = readFileSync(harness, 'utf8');
  assert.match(source, /kill -KILL -- "-\$pid"/);
  assert.match(source, /run-status\.json/);
  assert.match(source, /remaining CEF\/engine process group|remaining engine process/i);
  assert.match(source, /flock -n/);
  assert.match(source, /runId/);
  assert.match(source, /output directory must be empty|refusing to reuse/i);
  assert.match(source, /p20-take\.mjs/);
});

test('canonical evidence rejects a confirmed CEF renderer termination', () => {
  const source = readFileSync(harness, 'utf8');
  assert.match(source, /renderer_terminated/);
  assert.match(source, /CEF renderer terminated/);
});
