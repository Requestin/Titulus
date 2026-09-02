import assert from 'node:assert/strict';
import test from 'node:test';

import { createDefaultTemplate } from '../src/schema.js';
import {
  findUpdateDirector,
  hasUpdateDirector,
  resolveThumbnailFrame,
} from '../src/updateDirector.js';

test('findUpdateDirector matches Update/UPDATE/update', () => {
  const template = createDefaultTemplate();
  assert.equal(hasUpdateDirector(template.timeline), false);
  template.timeline.directors.push({
    id: 'upd',
    name: 'UPDATE',
    durationFrames: 40,
    offsetFrames: 0,
    autostart: false,
    loop: false,
    swing: false,
  });
  assert.equal(findUpdateDirector(template.timeline.directors)?.id, 'upd');
  assert.equal(hasUpdateDirector(template.timeline), true);
});

test('resolveThumbnailFrame prefers previewFrame then mid default', () => {
  const template = createDefaultTemplate();
  template.timeline.directors[0]!.durationFrames = 80;
  assert.equal(resolveThumbnailFrame(template.timeline), 40);
  template.timeline.cues = [{
    id: 'p',
    directorId: 'default',
    frame: 7,
    fromEnd: false,
    name: '',
    items: [{
      id: 't',
      command: 'tag',
      parameterTag: 'previewFrame',
      lengthFrames: 0,
      direction: 'both',
    }],
  }];
  assert.equal(resolveThumbnailFrame(template.timeline), 7);
});
