import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createDirectorMachine, sampleForApplyState } from '../src/directorMachine.js';
import { normalizeTimeline, timelineNeedsDirectorRuntime } from '../src/timeline.js';
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

test('sample does not fire cues or move local time', () => {
  const machine = createDirectorMachine(baseTimeline());
  for (let i = 0; i < 25; i += 1) machine.sample();
  assert.equal(machine.status('default'), 'running');
  assert.equal(machine.status('secondary'), 'idle');
  assert.equal(machine.waitingContinue(), false);
  assert.equal(machine.localFrame('default'), 0);
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

test('startDirector only wakes idle or stopped directors', () => {
  const tl = baseTimeline();
  tl.cues = [{
    id: 'start',
    directorId: 'default',
    frame: 1,
    fromEnd: false,
    name: '',
    items: [{
      id: 's',
      command: 'startDirector',
      parameterDirectorId: 'secondary',
      lengthFrames: 0,
      direction: 'both',
    }],
  }];
  const machine = createDirectorMachine(tl);
  machine.advance(1);
  assert.equal(machine.status('secondary'), 'running');
  machine.advance(2);
  assert.equal(machine.status('secondary'), 'running');
});

test('Update director plays from start, fires updateData, then returns to idle at 0', () => {
  const tags: string[] = [];
  const tl = baseTimeline();
  tl.directors.push({
    id: 'update',
    name: 'Update',
    durationFrames: 4,
    offsetFrames: 0,
    autostart: false,
    loop: false,
    swing: false,
  });
  tl.cues = [{
    id: 'swap',
    directorId: 'update',
    frame: 2,
    fromEnd: false,
    name: '',
    items: [{
      id: 'u',
      command: 'tag',
      parameterTag: 'updateData',
      lengthFrames: 0,
      direction: 'both',
    }],
  }];
  const machine = createDirectorMachine(tl, { onTag: (tag) => tags.push(tag) });
  assert.equal(machine.startUpdate(), true);
  assert.equal(machine.status('update'), 'running');
  assert.equal(machine.localFrame('update'), 0);
  machine.advance(1);
  machine.advance(2);
  assert.deepEqual(tags, ['updateData']);
  machine.advance(4);
  assert.equal(machine.status('update'), 'idle');
  assert.equal(machine.localFrame('update'), 0);
});

function waitContinueFlyIn(): Timeline {
  return {
    fps: 50,
    durationFrames: 101,
    playbackMode: 'bounded',
    directors: [
      {
        id: 'default',
        name: 'default',
        durationFrames: 101,
        offsetFrames: 0,
        autostart: true,
        loop: false,
        swing: false,
      },
    ],
    trackDirectors: { geo: 'default' },
    keyframes: [
      { id: 'k0', frame: 0, layers: {}, groups: { geo: { x: -424, y: -67 } }, easing: 'linear' },
      { id: 'k50', frame: 50, layers: {}, groups: { geo: { x: 302.75, y: 118 } }, easing: 'linear' },
      { id: 'k100', frame: 100, layers: {}, groups: { geo: { x: -424, y: -67 } }, easing: 'linear' },
    ],
    actions: [],
    cues: [{
      id: 'wait',
      directorId: 'default',
      frame: 50,
      fromEnd: false,
      name: '',
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

test('editor idle apply after seek follows global frame, not unadvanced machine locals', () => {
  const timeline = waitContinueFlyIn();
  assert.equal(timelineNeedsDirectorRuntime(timeline), true);
  const norm = normalizeTimeline(timeline);
  const machine = createDirectorMachine(timeline);
  const idle = sampleForApplyState(norm, 50, machine, {
    playbackMode: 'raf',
    playing: false,
    livePlayback: false,
  });
  assert.equal(idle.groups.geo?.x, 302.75);
  assert.equal(idle.groups.geo?.y, 118);
  assert.equal(machine.sample().groups.geo?.x, -424);
  assert.equal(machine.localFrame('default'), 0);
});

test('live play and engine ticks keep the wait-continue machine pose', () => {
  const timeline = waitContinueFlyIn();
  const norm = normalizeTimeline(timeline);
  const machine = createDirectorMachine(timeline);
  machine.advance(50);
  machine.advance(80);
  assert.equal(machine.status('default'), 'waiting');
  assert.equal(machine.localFrame('default'), 50);

  const live = sampleForApplyState(norm, 80, machine, {
    playbackMode: 'raf',
    playing: false,
    livePlayback: true,
  });
  assert.equal(live.groups.geo?.x, 302.75);

  const engine = sampleForApplyState(norm, 80, machine, {
    playbackMode: 'fixed',
    playing: false,
    livePlayback: false,
  });
  assert.equal(engine.groups.geo?.x, 302.75);

  const scrub = sampleForApplyState(norm, 80, machine, {
    playbackMode: 'raf',
    playing: false,
    livePlayback: false,
  });
  assert.notEqual(scrub.groups.geo?.x, 302.75);
});

test('startUpdate keeps a waiting default director frozen', () => {
  const timeline = waitContinueFlyIn();
  timeline.directors.push({
    id: 'update',
    name: 'Update',
    durationFrames: 100,
    offsetFrames: 0,
    autostart: false,
    loop: false,
    swing: false,
  });
  timeline.keyframes.push({
    id: 'u0',
    frame: 0,
    directorId: 'update',
    layers: { text: { x: -290 } },
    groups: {},
    easing: 'linear',
  });
  const machine = createDirectorMachine(timeline);
  machine.advance(50);
  assert.equal(machine.status('default'), 'waiting');
  assert.equal(machine.sample().groups.geo?.x, 302.75);
  machine.startUpdate();
  assert.equal(machine.status('default'), 'waiting');
  assert.equal(machine.status('update'), 'running');
  machine.advance(51);
  assert.equal(machine.status('default'), 'waiting');
  assert.equal(machine.localFrame('default'), 50);
  assert.equal(machine.localFrame('update'), 1);
  assert.equal(machine.sample().groups.geo?.x, 302.75);
});
