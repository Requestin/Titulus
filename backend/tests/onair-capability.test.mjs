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

function withLayerId(cmd, layerId) {
  return { ...cmd, layerId };
}

function undeclaredZTemplate(id) {
  const fixture = readFixture('old', 'test');
  return {
    ...fixture,
    id,
    layers: fixture.layers.map((layer, index) => (
      index === 0
        ? { ...layer, transform: { ...layer.transform, z: 12 } }
        : layer
    )),
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

test('clears quarantined persisted takes before replaying valid takes in z-order', () => {
  const db = openDb(':memory:');
  try {
    const dao = onAirDao(db);
    const unsupportedBackTake = takeCommand(undeclaredZTemplate('p21-quarantined-back'));
    const legacyBackTake = takeCommand(readFixture('old', 'test'));
    const unsupportedFrontTake = takeCommand(undeclaredZTemplate('p21-quarantined-front'));
    const layerFrontTake = takeCommand(readFixture('draft', 'layer-id-stack-a'));
    dao.set(unsupportedBackTake);
    dao.set(legacyBackTake);
    dao.set(unsupportedFrontTake);
    dao.set(layerFrontTake);

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
      layerFrontTake,
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
      [channelId]: [legacyBackTake.templateId, layerFrontTake.templateId],
    });
  } finally {
    db.close();
  }
});

test('rejects undeclared-capability takes before persistence or renderer fanout', () => {
  const db = openDb(':memory:');
  try {
    const dao = onAirDao(db);
    const manager = new OnAirManager(db);
    const renderer = fakeOpenRenderer();
    manager.registerRenderer(channelId, renderer);

    const unsupportedTake = takeCommand(undeclaredZTemplate('p21-undeclared-z'));
    assert.throws(
      () => manager.handleControlCommand(unsupportedTake),
      /unsupported.*capabilit|missing/i,
    );
    assert.equal(dao.get(channelId, unsupportedTake.templateId), null);
    assert.deepEqual(renderer.messages, []);
    assert.deepEqual(manager.onAirTemplateIds(), {});

    const legacyTake = takeCommand(readFixture('old', 'test'));
    manager.handleControlCommand(legacyTake);

    assert.deepEqual(dao.get(channelId, legacyTake.templateId), withLayerId(legacyTake, 50));
    assert.deepEqual(renderer.messages, [withLayerId(legacyTake, 50)]);
    assert.deepEqual(manager.onAirTemplateIds(), {
      [channelId]: [legacyTake.templateId],
    });
  } finally {
    db.close();
  }
});

test('accepts allowlisted vNext takes and stamps layerId on fanout', () => {
  const db = openDb(':memory:');
  try {
    const dao = onAirDao(db);
    const manager = new OnAirManager(db);
    const renderer = fakeOpenRenderer();
    manager.registerRenderer(channelId, renderer);

    const allowlistedTake = takeCommand(readFixture('draft', 'layer-id-stack-a'));
    manager.handleControlCommand(allowlistedTake);

    const stamped = withLayerId(allowlistedTake, 42);
    assert.deepEqual(dao.get(channelId, allowlistedTake.templateId), stamped);
    assert.deepEqual(renderer.messages, [stamped]);
    assert.deepEqual(manager.onAirTemplateIds(), {
      [channelId]: [allowlistedTake.templateId],
    });
    assert.equal(manager.onAirDetails().channels[channelId][0].layerId, 42);
  } finally {
    db.close();
  }
});
