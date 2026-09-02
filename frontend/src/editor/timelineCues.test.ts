import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Template } from '@runtime';
import {
  canRemoveDirector,
  canRenameDirector,
  constrainCueTag,
  createCue,
  cueFrameFromEffective,
  effectiveCueFrame,
  findCueAtEffectiveFrame,
  isProtectedUpdateDirector,
  mergeCueItems,
  stripCuesForDirector,
} from './timelineCues';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '../../..');

test('protected Update director cannot be renamed or removed', () => {
  const update = { id: 'update', name: 'Update' };
  const other = { id: 'default', name: 'default' };
  assert.equal(isProtectedUpdateDirector(update), true);
  assert.equal(canRenameDirector(update), false);
  assert.equal(canRemoveDirector([update, other], 'update'), false);
  assert.equal(canRemoveDirector([update, other], 'default'), true);
  assert.equal(canRemoveDirector([other], 'default'), false);
});

test('createCue assigns ids without requiring crypto.randomUUID', () => {
  const cue = createCue('default', 12);
  assert.equal(cue.directorId, 'default');
  assert.equal(cue.frame, 12);
  assert.ok(cue.id.length > 0);
  assert.ok(cue.items[0]!.id.length > 0);
  assert.equal(cue.items[0]!.command, '');
});

test('fromEnd round-trips against director duration', () => {
  const duration = 150;
  const effective = 125;
  const stored = cueFrameFromEffective(effective, true, duration);
  assert.equal(stored, 25);
  assert.equal(effectiveCueFrame({ frame: stored, fromEnd: true }, duration), effective);
});

test('cues on the same effective frame merge items', () => {
  const host = createCue('default', 10);
  const extra = createCue('default', 10);
  const merged = mergeCueItems(host, extra.items);
  assert.equal(merged.items.length, 2);
  assert.equal(findCueAtEffectiveFrame([host], 'default', 10, 300)?.id, host.id);
});

test('Update tags stay updateData; other directors cannot keep a second updateData', () => {
  const update = constrainCueTag(
    { id: 't', command: 'tag', parameterTag: 'endScene', lengthFrames: 0, direction: 'both' },
    { name: 'Update' },
    [],
  );
  assert.equal(update.command === 'tag' && update.parameterTag, 'updateData');

  const existing = createCue('default', 0);
  existing.items = [{ id: 'u', command: 'tag', parameterTag: 'updateData', lengthFrames: 0, direction: 'both' }];
  const second = constrainCueTag(
    { id: 't2', command: 'tag', parameterTag: 'updateData', lengthFrames: 0, direction: 'both' },
    { name: 'default' },
    [existing],
    'other',
  );
  assert.equal(second.command === 'tag' && second.parameterTag, 'endScene');
});

test('stripCuesForDirector removes host and targeted cues', () => {
  const fixture = JSON.parse(
    readFileSync(join(root, 'tests/fixtures/p21/draft/timeline-action-cues.json'), 'utf8'),
  ) as Template;
  const leftover = stripCuesForDirector(fixture.timeline, 'secondary');
  assert.equal(leftover.some((cue) => cue.directorId === 'secondary'), false);
  assert.equal(
    leftover.some((cue) => cue.items.some((item) => item.command !== 'tag' && item.parameterDirectorId === 'secondary')),
    false,
  );
});
