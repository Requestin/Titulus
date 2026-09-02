import assert from 'node:assert/strict';
import test from 'node:test';

import { thumbnailLabel, ensureXhtmlNamespace, wrapForeignObjectSvg } from './captureThumbnail';
import { resolveThumbnailFrame } from '@runtime';
import { createDefaultTemplate } from '@runtime';

test('thumbnailLabel keeps short names and ellipsizes long ones', () => {
  assert.equal(thumbnailLabel('Lower Third'), 'Lower Third');
  assert.equal(thumbnailLabel('  x  '), 'x');
  assert.equal(thumbnailLabel('a'.repeat(50)).endsWith('…'), true);
  assert.equal(thumbnailLabel('a'.repeat(50)).length, 42);
});

test('foreignObject SVG wraps HTML with an XHTML namespace', () => {
  const raw = '<div style="width:10px"></div>';
  const xhtml = ensureXhtmlNamespace(raw);
  assert.match(xhtml, /xmlns="http:\/\/www.w3.org\/1999\/xhtml"/);
  assert.equal(ensureXhtmlNamespace(xhtml), xhtml);
  const svg = wrapForeignObjectSvg(xhtml, 1920, 1080);
  assert.match(svg, /<foreignObject/);
  assert.match(svg, /width="1920"/);
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
