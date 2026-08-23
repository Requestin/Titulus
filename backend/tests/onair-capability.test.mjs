import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { onAirDao, openDb } from '../src/db.js';
import { OnAirManager } from '../src/onair.js';

const fixturesDirectory = fileURLToPath(
  new URL('../../tests/fixtures/p21/', import.meta.url),
);
const channelId = 'channel-capability-test';

function readFixture(kind, id) {
  return JSON.parse(readFileSync(join(fixturesDirectory, kind, `${id}.json`), 'utf8'));
}

function takeCommand(template) {
  return {
    type: 'take',
    channelId,
    templateId: template.id,
    template,
  };
}

function fakeOpenRenderer() {
  const messages = [];
  return {
    readyState: 1,
    messages,
    send(payload) {
      messages.push(JSON.parse(payload));
    },
  };
}

test('clears quarantined persisted takes before replaying valid legacy takes in z-order', () => {
  const db = openDb(':memory:');
  try {
    const dao = onAirDao(db);
    const unsupportedBackTake = takeCommand({
      ...readFixture('draft', 'scene-pivot-z'),
      id: 'p21-scene-pivot-z-back',
    });
    const legacyBackTake = takeCommand(readFixture('old', 'test'));
    const unsupportedFrontTake = takeCommand({
      ...readFixture('draft', 'scene-pivot-z'),
      id: 'p21-scene-pivot-z-front',
    });
    const legacyFrontTake = takeCommand(readFixture('old', 'test1'));
    dao.set(unsupportedBackTake);
    dao.set(legacyBackTake);
    dao.set(unsupportedFrontTake);
    dao.set(legacyFrontTake);

    const manager = new OnAirManager(db);
    const renderer = fakeOpenRenderer();
    manager.registerRenderer(channelId, renderer);

    assert.deepEqual(renderer.messages, [
      {
        type: 'clear',
        channelId,
        templateId: unsupportedBackTake.templateId,
      },
      {
        type: 'clear',
        channelId,
        templateId: unsupportedFrontTake.templateId,
      },
      legacyBackTake,
      legacyFrontTake,
    ]);
    assert.deepEqual(
      dao.get(channelId, unsupportedBackTake.templateId),
      unsupportedBackTake,
    );
    assert.deepEqual(
      dao.get(channelId, unsupportedFrontTake.templateId),
      unsupportedFrontTake,
    );
    assert.deepEqual(manager.onAirTemplateIds(), {
      [channelId]: [legacyBackTake.templateId, legacyFrontTake.templateId],
    });
  } finally {
    db.close();
  }
});

test('rejects unsupported direct takes before persistence or renderer fanout', () => {
  const db = openDb(':memory:');
  try {
    const dao = onAirDao(db);
    const manager = new OnAirManager(db);
    const renderer = fakeOpenRenderer();
    manager.registerRenderer(channelId, renderer);

    const unsupportedTake = takeCommand(readFixture('draft', 'scene-pivot-z'));
    assert.throws(
      () => manager.handleControlCommand(unsupportedTake),
      /unsupported.*capabilit/i,
    );
    assert.equal(dao.get(channelId, unsupportedTake.templateId), null);
    assert.deepEqual(renderer.messages, []);
    assert.deepEqual(manager.onAirTemplateIds(), {});

    const legacyTake = takeCommand(readFixture('old', 'test'));
    manager.handleControlCommand(legacyTake);

    assert.deepEqual(dao.get(channelId, legacyTake.templateId), legacyTake);
    assert.deepEqual(renderer.messages, [legacyTake]);
    assert.deepEqual(manager.onAirTemplateIds(), {
      [channelId]: [legacyTake.templateId],
    });
  } finally {
    db.close();
  }
});
