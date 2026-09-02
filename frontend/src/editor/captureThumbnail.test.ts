import assert from 'node:assert/strict';
import test from 'node:test';

import { thumbnailLabel } from './captureThumbnail';
import { resolveThumbnailFrame } from '@runtime';
import { createDefaultTemplate } from '@runtime';

test('thumbnailLabel keeps short names and ellipsizes long ones', () => {
  assert.equal(thumbnailLabel('Lower Third'), 'Lower Third');
  assert.equal(thumbnailLabel('  x  '), 'x');
  assert.equal(thumbnailLabel('a'.repeat(50)).endsWith('…'), true);
  assert.equal(thumbnailLabel('a'.repeat(50)).length, 42);
});

test('resolveThumbnailFrame uses previewFrame tag then mid default', () => {
  const template = createDefaultTemplate();
  template.timeline.directors[0]!.durationFrames = 100;
  assert.equal(resolveThumbnailFrame(template.timeline), 50);
  template.timeline.cues = [{
    id: 'preview',
    directorId: 'default',
    frame: 12,
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
  assert.equal(resolveThumbnailFrame(template.timeline), 12);
});
