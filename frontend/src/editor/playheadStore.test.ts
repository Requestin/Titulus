import assert from 'node:assert/strict';
import test from 'node:test';
import type { TimelineDirector } from '@runtime';
import {
  bindPlaybackControls,
  playheadStore,
  preparePlayStart,
  scrubGlobalPlayhead,
  setLivePlaying,
  startBoundPlayback,
  stopBoundPlayback,
} from './playheadStore';

const director: TimelineDirector = {
  id: 'default',
  name: 'Default',
  durationFrames: 100,
  offsetFrames: 0,
  autostart: true,
  loop: true,
  swing: true,
};

test('every Go-to-start then Play creates a live playback session', () => {
  playheadStore.setState({
    playhead: 0,
    globalPlayhead: 0,
    localPlayheads: {},
    detachedLocals: {},
    playing: false,
    playSessionId: 0,
    continueRequestId: 0,
    waitingContinue: false,
  });

  for (let expectedSession = 1; expectedSession <= 20; expectedSession += 1) {
    setLivePlaying(false);
    scrubGlobalPlayhead(0, [director], director.id);
    preparePlayStart([director], director.id);

    const state = playheadStore.getState();
    assert.equal(state.playing, true);
    assert.equal(state.playSessionId, expectedSession);
    assert.equal(state.globalPlayhead, 0);
    assert.equal(state.localPlayheads[director.id], 0);
  }
});

test('Go-to-start then Play starts the bound canvas loop every time', () => {
  let starts = 0;
  let stops = 0;
  const unbind = bindPlaybackControls({
    start: () => { starts += 1; },
    stop: () => { stops += 1; },
  });

  playheadStore.setState({
    playhead: 40,
    globalPlayhead: 40,
    localPlayheads: { default: 40 },
    detachedLocals: {},
    playing: true,
    playSessionId: 3,
    continueRequestId: 0,
    waitingContinue: false,
  });

  for (let i = 0; i < 6; i += 1) {
    stopBoundPlayback();
    setLivePlaying(false);
    scrubGlobalPlayhead(0, [director], director.id);
    preparePlayStart([director], director.id);
    startBoundPlayback();
    assert.equal(playheadStore.getState().playing, true);
  }

  assert.equal(starts, 6);
  assert.equal(stops, 6);
  unbind();
});
