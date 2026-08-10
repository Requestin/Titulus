import assert from 'node:assert/strict';
import test from 'node:test';

import { videoPlaybackElementKind } from '../src/videoPlayback.js';

test('animated WebP playback uses an image element', () => {
  assert.equal(videoPlaybackElementKind('/uploads/alpha.webp'), 'image');
  assert.equal(videoPlaybackElementKind('/uploads/ALPHA.WEBP?v=2'), 'image');
});

test('regular playback derivatives keep the video element', () => {
  assert.equal(videoPlaybackElementKind('/uploads/opaque.mp4'), 'video');
  assert.equal(videoPlaybackElementKind('/uploads/legacy.webm'), 'video');
});
