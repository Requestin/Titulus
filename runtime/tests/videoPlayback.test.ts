import assert from 'node:assert/strict';
import test from 'node:test';

import { videoPlaybackElementKind, videoWindowOpen } from '../src/videoPlayback.js';

test('animated WebP playback uses an image element', () => {
  assert.equal(videoPlaybackElementKind('/uploads/alpha.webp'), 'image');
  assert.equal(videoPlaybackElementKind('/uploads/ALPHA.WEBP?v=2'), 'image');
});

test('regular playback derivatives keep the video element', () => {
  assert.equal(videoPlaybackElementKind('/uploads/opaque.mp4'), 'video');
  assert.equal(videoPlaybackElementKind('/uploads/legacy.webm'), 'video');
});

test('video visibility window is open when bounds are omitted', () => {
  assert.equal(videoWindowOpen({ type: 'video' }, 0), true);
  assert.equal(videoWindowOpen({ type: 'video' }, 250), true);
  assert.equal(videoWindowOpen({ type: 'text' }, 0), true);
});

test('video visibility window uses inclusive in and exclusive out', () => {
  const layer = { type: 'video', inFrame: 10, outFrame: 40 };
  assert.equal(videoWindowOpen(layer, 9), false);
  assert.equal(videoWindowOpen(layer, 10), true);
  assert.equal(videoWindowOpen(layer, 39), true);
  assert.equal(videoWindowOpen(layer, 40), false);
});

test('empty video visibility window stays closed', () => {
  assert.equal(videoWindowOpen({ type: 'video', inFrame: 20, outFrame: 20 }, 20), false);
  assert.equal(videoWindowOpen({ type: 'video', inFrame: 20, outFrame: 10 }, 15), false);
});
