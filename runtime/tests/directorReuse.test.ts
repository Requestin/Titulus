import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDirectorMachine,
  reuseOrCreateDirectorMachine,
} from '../src/directorMachine.js';
import type { Timeline } from '../src/schema.js';

function waitTimeline(): Timeline {
  return {
    fps: 50,
    durationFrames: 200,
    playbackMode: 'bounded',
    directors: [
      { id: 'default', name: 'default', durationFrames: 200, offsetFrames: 0, autostart: true, loop: false, swing: false },
    ],
    trackDirectors: {},
    keyframes: [],
    actions: [],
    cues: [{
      id: 'wait',
      directorId: 'default',
      frame: 5,
      fromEnd: false,
      name: 'wait',
      items: [{
        id: 'w',
        command: 'stopDirectorAndWaitContinue',
        parameterDirectorId: 'default',
        lengthFrames: 0,
        direction: 'normal',
      }],
    }],
  };
}

test('reuseOrCreateDirectorMachine keeps wait state on UPDATE reuse', () => {
  const timeline = waitTimeline();
  const machine = createDirectorMachine(timeline);
  machine.advance(6);
  assert.equal(machine.status('default'), 'waiting');
  const reused = reuseOrCreateDirectorMachine(machine, timeline, true);
  assert.equal(reused, machine);
  assert.equal(reused?.status('default'), 'waiting');
  const recreated = reuseOrCreateDirectorMachine(machine, timeline, false);
  assert.notEqual(recreated, machine);
  assert.equal(recreated?.status('default'), 'running');
});
