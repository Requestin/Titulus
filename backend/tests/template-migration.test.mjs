import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  migrateTemplate,
  TemplateMigrationError,
} from '../src/templateMigration.js';

const fixturesDirectory = fileURLToPath(
  new URL('../../tests/fixtures/p21/', import.meta.url),
);

function readFixture(kind, id) {
  return JSON.parse(readFileSync(join(fixturesDirectory, kind, `${id}.json`), 'utf8'));
}

function legacyTemplateWithActions() {
  const template = readFixture('old', 'test1');
  template.timeline.actions = [
    {
      id: 'start-default',
      directorId: 'default',
      frame: 25,
      command: 'startDirector',
      targetDirectorId: 'default',
    },
    {
      id: 'stop-default',
      directorId: 'default',
      frame: 25,
      command: 'stopDirector',
      targetDirectorId: 'default',
    },
    {
      id: 'end-scene',
      directorId: 'default',
      frame: 100,
      command: 'setTag',
      tag: 'End scene',
    },
  ];
  return template;
}

test('canonicalizes flat legacy actions into deterministic grouped cues', () => {
  const input = legacyTemplateWithActions();
  const migrated = migrateTemplate(input);
  const repeated = migrateTemplate(structuredClone(input));

  assert.deepEqual(migrated, repeated, 'migration output must be deterministic');
  assert.deepEqual(migrated.timeline.actions, []);
  assert.equal(migrated.timeline.cues.length, 2);

  const [directorCue, tagCue] = migrated.timeline.cues;
  assert.deepEqual(
    {
      directorId: directorCue.directorId,
      frame: directorCue.frame,
      fromEnd: directorCue.fromEnd,
      commands: directorCue.items.map((item) => item.command),
      targets: directorCue.items.map((item) => item.parameterDirectorId),
    },
    {
      directorId: 'default',
      frame: 25,
      fromEnd: false,
      commands: ['startDirector', 'stopDirector'],
      targets: ['default', 'default'],
    },
  );
  assert.deepEqual(
    {
      directorId: tagCue.directorId,
      frame: tagCue.frame,
      fromEnd: tagCue.fromEnd,
      command: tagCue.items[0].command,
      parameterTag: tagCue.items[0].parameterTag,
    },
    {
      directorId: 'default',
      frame: 100,
      fromEnd: false,
      command: 'tag',
      parameterTag: 'endScene',
    },
  );
  for (const cue of migrated.timeline.cues) {
    assert.equal(typeof cue.id, 'string');
    assert.ok(cue.id.length > 0);
    assert.equal(typeof cue.name, 'string');
    for (const item of cue.items) {
      assert.equal(typeof item.id, 'string');
      assert.ok(item.id.length > 0);
      assert.equal(item.lengthFrames, 0);
      assert.equal(item.direction, 'normal');
    }
  }
});

test('preserves classic geometry, rootStack and keyframes during migration', () => {
  const input = legacyTemplateWithActions();
  const classic = {
    canvas: structuredClone(input.canvas),
    groups: structuredClone(input.groups),
    layers: structuredClone(input.layers),
    rootStack: structuredClone(input.rootStack),
    groupStacks: structuredClone(input.groupStacks),
    keyframes: structuredClone(input.timeline.keyframes),
  };

  const migrated = migrateTemplate(input);

  assert.deepEqual(migrated.canvas, classic.canvas);
  assert.deepEqual(migrated.groups, classic.groups);
  assert.deepEqual(migrated.layers, classic.layers);
  assert.deepEqual(migrated.rootStack, classic.rootStack);
  assert.deepEqual(migrated.groupStacks, classic.groupStacks);
  assert.deepEqual(migrated.timeline.keyframes, classic.keyframes);
});

test('rejects ambiguous legacy Stop tag with a typed clear error', () => {
  const input = legacyTemplateWithActions();
  input.timeline.actions = [{
    id: 'ambiguous-stop',
    directorId: 'default',
    frame: 50,
    command: 'setTag',
    tag: 'Stop',
  }];

  assert.throws(
    () => migrateTemplate(input),
    (error) => {
      assert.ok(error instanceof TemplateMigrationError);
      assert.equal(error.code, 'AMBIGUOUS_LEGACY_STOP_TAG');
      assert.match(error.message, /legacy.*Stop.*ambiguous/i);
      return true;
    },
  );
});

test('migration is non-mutating and idempotent', () => {
  const input = legacyTemplateWithActions();
  const snapshot = structuredClone(input);

  const once = migrateTemplate(input);
  const twice = migrateTemplate(once);

  assert.deepEqual(input, snapshot, 'migration mutated its input');
  assert.notStrictEqual(once, input, 'migration must return a detached value');
  assert.deepEqual(twice, once, 'migration must be idempotent');
});

test('leaves already canonical cues unchanged', () => {
  const canonical = readFixture('draft', 'timeline-action-cues');
  const snapshot = structuredClone(canonical);

  const migrated = migrateTemplate(canonical);

  assert.deepEqual(migrated, snapshot);
  assert.deepEqual(canonical, snapshot, 'canonical input was mutated');
  assert.notStrictEqual(migrated, canonical);
});
