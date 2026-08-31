import assert from 'node:assert/strict';
import test from 'node:test';
import type { TimelineDirector } from '@runtime';
import {
  playheadStore,
  preparePlayStart,
  scrubGlobalPlayhead,
  setLivePlaying,
} from './playheadStore';

const director: TimelineDirector = {
  id: 'default',
  name: 'Default',
  durationFrames: 100,
  offsetFrames: 0,
  autostart: true,
  loop: false,
  swing: false,
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
