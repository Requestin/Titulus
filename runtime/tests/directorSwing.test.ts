import assert from 'node:assert/strict';
import test from 'node:test';

import type { TimelineDirector } from '../src/schema.js';
import { directorLocalFrame } from '../src/timeline.js';

function director(partial: Partial<TimelineDirector>): TimelineDirector {
  return {
    id: 'd',
    name: 'd',
    durationFrames: 100,
    offsetFrames: 0,
    autostart: true,
    loop: false,
    swing: false,
    ...partial,
  };
}

test('swing ping-pongs local frame forward then back', () => {
  const d = director({ swing: true, durationFrames: 100 });
  assert.equal(directorLocalFrame(d, 0), 0);
  assert.equal(directorLocalFrame(d, 50), 50);
  assert.equal(directorLocalFrame(d, 100), 100);
  assert.equal(directorLocalFrame(d, 150), 50);
  assert.equal(directorLocalFrame(d, 200), 0);
  assert.equal(directorLocalFrame(d, 250), 50);
});

test('non-swing loop wraps forward only', () => {
  const d = director({ loop: true, swing: false, durationFrames: 100 });
  assert.equal(directorLocalFrame(d, 100), 100);
  assert.equal(directorLocalFrame(d, 150), 50);
  assert.equal(directorLocalFrame(d, 200), 0);
});

test('bounded director holds at end without loop/swing', () => {
  const d = director({ loop: false, swing: false, durationFrames: 100 });
  assert.equal(directorLocalFrame(d, 150), 100);
});
