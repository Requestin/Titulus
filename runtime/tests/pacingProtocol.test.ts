import assert from 'node:assert/strict';
import test from 'node:test';

import {
  encodePacingEvent,
  PACING_HEADER,
  type PacingEvent,
} from '../src/pacingProtocol.js';

function event(overrides: Partial<PacingEvent> = {}): PacingEvent {
  return {
    runtimeEventSeq: 7,
    rafSeq: 11,
    runtimePerfUs: 22_000,
    runtimeUnixUs: 1_725_000_000_000_000,
    rafDeltaUs: 20_000,
    ticksPerRaf: 2,
    logicalFrameBefore: 100,
    logicalFrameAfter: 102,
    activeCount: 1,
    identityValid: true,
    templateId: 'template-1',
    graphRevision: 3,
    stateRevision: 9,
    ...overrides,
  };
}

test('encodes a bounded BGPACING v1 event', () => {
  assert.equal(
    encodePacingEvent(event()),
    `${PACING_HEADER} ev=7,raf=11,rperf=22000,runix=1725000000000000,`
      + 'rdelta=20000,ticks=2,lf_before=100,lf_after=102,active=1,valid=1,'
      + 'template=template-1,graph=3,state=9',
  );
});

test('uses no template identity for ambiguous active templates', () => {
  const encoded = encodePacingEvent(event({
    activeCount: 2,
    identityValid: false,
    templateId: null,
    logicalFrameBefore: 0,
    logicalFrameAfter: 0,
    graphRevision: 0,
    stateRevision: 0,
  }));
  assert.ok(encoded?.includes('active=2,valid=0,template=-,graph=0,state=0'));
});

test('rejects unsafe or out-of-range event fields', () => {
  assert.equal(encodePacingEvent(event({ templateId: 'bad template' })), null);
  assert.equal(encodePacingEvent(event({ ticksPerRaf: 5 })), null);
  assert.equal(encodePacingEvent(event({ runtimeEventSeq: -1 })), null);
});
