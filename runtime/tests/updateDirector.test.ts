import assert from 'node:assert/strict';
import test from 'node:test';

import { createDefaultTemplate } from '../src/schema.js';
import {
  ensureUpdateDirector,
  findUpdateDirector,
  hasUpdateDirector,
  hasUpdateDirectorTracks,
  resolveThumbnailFrame,
} from '../src/updateDirector.js';

test('findUpdateDirector matches Update/UPDATE/update', () => {
  const template = createDefaultTemplate();
  assert.equal(hasUpdateDirector(template.timeline), true);
  assert.equal(hasUpdateDirectorTracks(template.timeline), false);
  assert.equal(findUpdateDirector(template.timeline.directors)?.id, 'update');
  template.timeline.directors.push({
    id: 'upd',
    name: 'UPDATE',
    durationFrames: 40,
    offsetFrames: 0,
    autostart: false,
    loop: false,
    swing: false,
  });
  assert.equal(findUpdateDirector(template.timeline.directors)?.id, 'update');
});

test('hasUpdateDirectorTracks is true only when Update owns a track', () => {
  const template = createDefaultTemplate();
  template.timeline.propertyTrackDirectors = {
    box: { x: 'update' },
  };
  assert.equal(hasUpdateDirectorTracks(template.timeline), true);
});

test('hasUpdateDirectorTracks sees director-scoped duplicate keyframes', () => {
  const template = createDefaultTemplate();
  template.timeline.keyframes.push({
    id: 'dup',
    frame: 0,
    directorId: 'update',
    layers: { box: { x: 1 } },
    groups: {},
    easing: 'linear',
  });
  assert.equal(hasUpdateDirectorTracks(template.timeline), true);
});

test('ensureUpdateDirector is a no-op when Update already exists', () => {
  const template = createDefaultTemplate();
  const before = template.timeline.directors.length;
  ensureUpdateDirector(template.timeline);
  assert.equal(template.timeline.directors.length, before);
});

test('ensureUpdateDirector injects Update + updateData tag when missing', () => {
  const template = createDefaultTemplate();
  template.timeline.directors = template.timeline.directors.filter((d) => d.id !== 'update');
  template.timeline.cues = [];
  ensureUpdateDirector(template.timeline);
  assert.equal(findUpdateDirector(template.timeline.directors)?.name, 'Update');
  assert.equal(
    template.timeline.cues?.some((cue) => (
      cue.frame === 50
      && cue.items.some((item) => item.command === 'tag' && item.parameterTag === 'updateData')
    )),
    true,
  );
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
