import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Template, Timeline } from '../src/schema.js';
import {
  compileCues,
  cuesCrossed,
  resolveCueFrame,
  timelineNeedsDirectorRuntime,
} from '../src/timeline.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function loadTemplate(rel: string): Template {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')) as Template;
}

function emptyTimeline(): Timeline {
  return {
    fps: 50,
    durationFrames: 200,
    playbackMode: 'bounded',
    directors: [
      { id: 'default', name: 'default', durationFrames: 200, offsetFrames: 0, autostart: true, loop: false, swing: false },
      { id: 'update', name: 'Update', durationFrames: 80, offsetFrames: 0, autostart: false, loop: false, swing: false },
    ],
    trackDirectors: {},
    keyframes: [],
    actions: [],
  };
}

test('canonical templates stay on the classic sample path', () => {
  const testTpl = loadTemplate('tests/templates/test.json');
  const test1 = loadTemplate('tests/templates/test1.json');
  assert.equal(timelineNeedsDirectorRuntime(testTpl.timeline), false);
  assert.equal(timelineNeedsDirectorRuntime(test1.timeline), false);
});

test('empty or dormant Update and tags-only cues do not enable the director runtime', () => {
  const dormant = emptyTimeline();
  dormant.cues = [];
  assert.equal(timelineNeedsDirectorRuntime(dormant), false);

  const tagsOnly = emptyTimeline();
  tagsOnly.cues = [{
    id: 'tag',
    directorId: 'update',
    frame: 10,
    fromEnd: false,
    name: 'update data',
    items: [{
      id: 't',
      command: 'tag',
      parameterTag: 'updateData',
      lengthFrames: 0,
      direction: 'both',
    }],
  }];
  assert.equal(timelineNeedsDirectorRuntime(tagsOnly), false);

  const legacyTag = emptyTimeline();
  legacyTag.actions = [{
    id: 'legacy',
    directorId: 'default',
    frame: 4,
    command: 'setTag',
    targetDirectorId: null,
    tag: 'Stop',
  }];
  assert.equal(timelineNeedsDirectorRuntime(legacyTag), false);
});

test('director-scoped keyframes enable the director runtime', () => {
  const timeline = emptyTimeline();
  timeline.keyframes.push({
    id: 'dup',
    frame: 0,
    directorId: 'update',
    layers: { box: { x: 1 } },
    groups: {},
    easing: 'linear',
  });
  assert.equal(timelineNeedsDirectorRuntime(timeline), true);
});

test('stateful cue commands and legacy start/stop enable the director runtime', () => {
  const wait = emptyTimeline();
  wait.cues = [{
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
  }];
  assert.equal(timelineNeedsDirectorRuntime(wait), true);

  const legacyStart = emptyTimeline();
  legacyStart.actions = [{
    id: 'start',
    directorId: 'default',
    frame: 2,
    command: 'startDirector',
    targetDirectorId: 'update',
    tag: null,
  }];
  assert.equal(timelineNeedsDirectorRuntime(legacyStart), true);
});

test('fromEnd resolves against the owning director duration and crossed lookup is ordered', () => {
  const fixture = loadTemplate('tests/fixtures/p21/draft/timeline-action-cues.json');
  const compiled = compileCues(fixture.timeline);
  const stop = compiled.secondary.find((cue) => cue.id === 'stop-secondary-from-end' || cue.name === 'Stop secondary from end');
  assert.ok(stop);
  assert.equal(resolveCueFrame({
    id: 'x',
    directorId: 'secondary',
    frame: 25,
    fromEnd: true,
    name: 'x',
    items: fixture.timeline.cues![2]!.items,
  }, 150), 125);
  assert.equal(stop.frame, 125);

  const crossed = cuesCrossed(compiled, 'secondary', 100, 130, 'reverse');
  assert.deepEqual(crossed.map((cue) => cue.frame), [125]);
  assert.deepEqual(cuesCrossed(compiled, 'secondary', 100, 130, 'normal'), []);
  assert.deepEqual(cuesCrossed(compiled, 'secondary', 130, 140, 'reverse'), []);
});
