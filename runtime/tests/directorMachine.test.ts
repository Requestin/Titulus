import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createDirectorMachine } from '../src/directorMachine.js';
import { timelineNeedsDirectorRuntime } from '../src/timeline.js';
import type { Template, Timeline } from '../src/schema.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function load(rel: string): Template {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')) as Template;
}

function baseTimeline(): Timeline {
  return {
    fps: 50,
    durationFrames: 300,
    playbackMode: 'bounded',
    directors: [
      { id: 'default', name: 'default', durationFrames: 300, offsetFrames: 0, autostart: true, loop: false, swing: false },
      { id: 'secondary', name: 'Secondary', durationFrames: 80, offsetFrames: 0, autostart: false, loop: false, swing: false },
    ],
    trackDirectors: {},
    keyframes: [],
    actions: [],
    cues: [
      {
        id: 'start',
        directorId: 'default',
        frame: 5,
        fromEnd: false,
        name: 'start secondary',
        items: [{
          id: 's',
          command: 'startDirector',
          parameterDirectorId: 'secondary',
          lengthFrames: 0,
          direction: 'normal',
        }],
      },
      {
        id: 'wait',
        directorId: 'default',
        frame: 20,
        fromEnd: false,
        name: 'wait',
        items: [{
          id: 'w',
          command: 'stopDirectorAndWaitContinue',
          parameterDirectorId: 'default',
          lengthFrames: 0,
          direction: 'normal',
        }],
      },
    ],
  };
}

test('canonical test1 does not need the director machine', () => {
  const test1 = load('tests/templates/test1.json');
  assert.equal(timelineNeedsDirectorRuntime(test1.timeline), false);
});

test('autostart director runs, startDirector wakes a dormant director, wait freezes until continue', () => {
  const machine = createDirectorMachine(baseTimeline());
  machine.advance(4);
  assert.equal(machine.status('default'), 'running');
  assert.equal(machine.status('secondary'), 'idle');
  assert.equal(machine.waitingContinue(), false);

  machine.advance(5);
  assert.equal(machine.status('secondary'), 'running');

  machine.advance(20);
  assert.equal(machine.status('default'), 'waiting');
  assert.equal(machine.waitingContinue(), true);
  const frozen = machine.localFrame('default');
  machine.advance(21);
  assert.equal(machine.localFrame('default'), frozen);

  machine.continue();
  assert.equal(machine.status('default'), 'running');
  assert.equal(machine.waitingContinue(), false);
  machine.advance(22);
  assert.ok((machine.localFrame('default') ?? 0) > (frozen ?? 0));
});

test('pause holds for lengthFrames then resumes', () => {
  const tl = baseTimeline();
  tl.cues = [{
    id: 'pause',
    directorId: 'default',
    frame: 3,
    fromEnd: false,
    name: 'pause',
    items: [{
      id: 'p',
      command: 'pauseDirector',
      parameterDirectorId: 'default',
      lengthFrames: 2,
      direction: 'normal',
    }],
  }];
  const machine = createDirectorMachine(tl);
  machine.advance(3);
  assert.equal(machine.status('default'), 'paused');
  machine.advance(4);
  assert.equal(machine.status('default'), 'paused');
  machine.advance(5);
  assert.equal(machine.status('default'), 'running');
});

test('endScene tag is recorded and does not freeze the director', () => {
  const tl = baseTimeline();
  tl.cues = [{
    id: 'end',
    directorId: 'default',
    frame: 2,
    fromEnd: false,
    name: 'end',
    items: [{
      id: 'e',
      command: 'tag',
      parameterTag: 'endScene',
      lengthFrames: 0,
      direction: 'both',
    }],
  }];
  const machine = createDirectorMachine(tl);
  machine.advance(2);
  assert.equal(machine.endScene(), true);
  assert.equal(machine.status('default'), 'running');
});
