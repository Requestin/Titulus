import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { validateTemplate } from '../../../../backend/src/templateValidation.js';
import {
  generateP20MovingBarTemplate,
} from '../generate-semantic-marker.mjs';
import {
  analyzeSemanticFields,
  assessSemanticAcceptance,
  parseCsv,
} from '../lib/analyze-semantic-fields.mjs';

const repoRoot = new URL('../../../..', import.meta.url);
const fixtureRoot = new URL('./fixtures/', import.meta.url);
const harness = new URL('../run-p20-pacing-probe.sh', import.meta.url);

function fixture(name) {
  return new URL(name, fixtureRoot).pathname;
}

test('generates the deterministic P20 semantic marker v1 and checks in its schema-valid artifact', () => {
  const generated = generateP20MovingBarTemplate();
  const checkedIn = JSON.parse(readFileSync(
    new URL('../../../../tests/templates/p20-moving-bar.json', import.meta.url),
    'utf8',
  ));

  assert.deepEqual(generated, checkedIn);
  assert.deepEqual(validateTemplate(generated), { valid: true, errors: [] });
  assert.equal(generated.schemaVersion, '1.0.0');
  assert.equal(generated.metadata.category, 'p20-semantic-marker-v1');
  assert.equal(generated.timeline.fps, 50);

  const bar = generated.layers.find((layer) => layer.id === 'p20-semantic-bar');
  assert.ok(bar);
  assert.equal(bar.transform.height, 720);
  assert.equal(bar.transform.y, 180);
  const clock = generated.layers.find((layer) => layer.id === 'p20-marker-clock');
  assert.ok(clock);
  assert.equal(clock.type, 'clock');
  assert.equal(clock.format, 'HH:mm:ss');

  const states = generated.timeline.keyframes.map((keyframe) => (
    keyframe.layers['p20-semantic-bar'].x
  ));
  assert.equal(states.length, 65);
  assert.deepEqual(states.slice(0, 64), Array.from({ length: 64 }, (_, id) => 144 + id * 24));
  assert.equal(states.at(-1), 144);
});

test('classifies duplicate, skipped, reversed and undecodable semantic field IDs', () => {
  const report = analyzeSemanticFields(parseCsv(readFileSync(
    fixture('p20-semantic-anomalies.csv'),
    'utf8',
  )));

  assert.equal(report.schemaVersion, 'p20-semantic-fields-v1');
  assert.equal(report.streams.length, 1);
  assert.deepEqual(report.streams[0].counts, {
    decoded: 5,
    duplicate: 1,
    skipped: 1,
    reversed: 1,
    undecodable: 1,
    parityMismatch: 0,
  });
  assert.deepEqual(
    report.streams[0].anomalies.map((anomaly) => anomaly.kind),
    ['duplicate', 'skipped', 'reversed', 'undecodable'],
  );
  assert.equal(report.healthy, false);
});

test('requires capture-order field indexes and the semantic field CSV contract', () => {
  assert.throws(
    () => analyzeSemanticFields(parseCsv([
      'unix_us,output_channel,capture_input,field_index,semantic_id,field_parity,expected_parity,frame_hash',
      '1725000000000000,ch1,in1,2,10,odd,odd,a',
      '1725000000020000,ch1,in1,1,11,even,even,b',
    ].join('\n'))),
    /strictly increase/,
  );

  assert.throws(
    () => analyzeSemanticFields(parseCsv([
      'unix_us,capture_input,field_index,semantic_id,field_parity,expected_parity,frame_hash',
      '1725000000000000,in1,1,10,odd,odd,a',
    ].join('\n'))),
    /requires output_channel/,
  );
});

test('strict semantic acceptance rejects empty and anomalous captures', () => {
  const empty = analyzeSemanticFields(parseCsv([
    'unix_us,output_channel,capture_input,field_index,semantic_id,field_parity,expected_parity,frame_hash',
  ].join('\n')));
  const anomalous = analyzeSemanticFields(parseCsv(readFileSync(
    fixture('p20-semantic-anomalies.csv'),
    'utf8',
  )));

  assert.equal(assessSemanticAcceptance(empty).healthy, false);
  assert.match(assessSemanticAcceptance(empty).errors.join('\n'), /no field rows|no decoded fields/);
  assert.equal(assessSemanticAcceptance(anomalous).healthy, false);
  assert.match(assessSemanticAcceptance(anomalous).errors.join('\n'), /duplicate=1/);
});

test('safe pacing harness writes a dry-run manifest without launching hardware', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'titulus-p20-probe-'));
  execFileSync('bash', [
    harness.pathname,
    '--channel=00000000-0000-4000-8000-000000000001',
    `--out-dir=${outDir}`,
    '--duration=30',
  ], {
    cwd: repoRoot.pathname,
    stdio: 'pipe',
  });

  const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 'p20-pacing-probe-v1');
  assert.equal(manifest.execution.mode, 'dry_run');
  assert.equal(manifest.execution.decklinkArmed, false);
  assert.equal(manifest.template.path, 'tests/templates/p20-moving-bar.json');
  assert.match(manifest.plannedCommand.join(' '), /--frame-log=/);
  assert.match(manifest.plannedCommand.join(' '), /--decklink-completion-log=/);
  assert.match(manifest.plannedCommand.join(' '), /pacing=1/);
});
