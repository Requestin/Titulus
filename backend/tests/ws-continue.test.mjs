import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { onAirDao, openDb } from '../src/db.js';
import { OnAirManager } from '../src/onair.js';
import { applyRendererMessage, normalizeControlMessage, normalizeRendererMessage } from '../src/routes/ws.js';

const fixturesDirectory = fileURLToPath(
  new URL('../../tests/fixtures/p21/', import.meta.url),
);
const channelId = 'channel-continue-test';

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

function orderIndex(db, templateId) {
  return db.prepare(
    'SELECT order_index FROM on_air WHERE channel_id = ? AND template_id = ?',
  ).get(channelId, templateId)?.order_index ?? null;
}

test('normalizeControlMessage accepts continue and drops unknown fields', () => {
  const result = normalizeControlMessage({
    type: 'continue',
    channelId,
    templateId: 'tpl-1',
    directorId: 'default',
    slotId: 'slot-9',
    waiting: true,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    type: 'continue',
    channelId,
    templateId: 'tpl-1',
    template: undefined,
    variables: undefined,
  });
  assert.equal('directorId' in result.value, false);
  assert.equal('slotId' in result.value, false);
});

test('normalizeControlMessage still rejects unknown types without an ACK-shaped success', () => {
  const result = normalizeControlMessage({
    type: 'foo',
    channelId,
    templateId: 'tpl-1',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNKNOWN_TYPE');
});

test('normalizeControlMessage requires templateId for continue', () => {
  const result = normalizeControlMessage({
    type: 'continue',
    channelId,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_TEMPLATE_ID');
});

test('continue fans out without persisting or bumping z-order', () => {
  const db = openDb(':memory:');
  try {
    const dao = onAirDao(db);
    const manager = new OnAirManager(db);
    const renderer = fakeOpenRenderer();
    manager.registerRenderer(channelId, renderer);

    const legacyTake = takeCommand(readFixture('old', 'test'));
    manager.handleControlCommand(legacyTake);
    const storedAfterTake = dao.get(channelId, legacyTake.templateId);
    const orderAfterTake = orderIndex(db, legacyTake.templateId);
    const snapshotAfterTake = manager.onAirTemplateIds();
    renderer.messages.length = 0;

    manager.handleControlCommand({
      type: 'continue',
      channelId,
      templateId: legacyTake.templateId,
    });

    assert.deepEqual(dao.get(channelId, legacyTake.templateId), storedAfterTake);
    assert.equal(orderIndex(db, legacyTake.templateId), orderAfterTake);
    assert.deepEqual(manager.onAirTemplateIds(), snapshotAfterTake);
    assert.deepEqual(renderer.messages, [{
      type: 'continue',
      channelId,
      templateId: legacyTake.templateId,
    }]);
  } finally {
    db.close();
  }
});

test('reconnect replays takes only and never a continue', () => {
  const db = openDb(':memory:');
  try {
    const manager = new OnAirManager(db);
    const first = fakeOpenRenderer();
    manager.registerRenderer(channelId, first);

    const legacyTake = takeCommand(readFixture('old', 'test'));
    manager.handleControlCommand(legacyTake);
    manager.handleControlCommand({
      type: 'continue',
      channelId,
      templateId: legacyTake.templateId,
    });

    const reconnect = fakeOpenRenderer();
    manager.registerRenderer(channelId, reconnect);
    assert.deepEqual(reconnect.messages, [{ ...legacyTake, layerId: 50 }]);
    assert.equal(reconnect.messages.some((msg) => msg.type === 'continue'), false);
  } finally {
    db.close();
  }
});

test('legacy on-air string[] snapshot stays unchanged when details waitingContinue flips', () => {
  const db = openDb(':memory:');
  try {
    const manager = new OnAirManager(db);
    const legacyTake = takeCommand(readFixture('old', 'test'));
    manager.handleControlCommand(legacyTake);

    assert.deepEqual(manager.onAirTemplateIds(), {
      [channelId]: [legacyTake.templateId],
    });
    assert.deepEqual(manager.onAirDetails(), {
      schemaVersion: 'onair-details-v1',
      channels: {
        [channelId]: [{
          templateId: legacyTake.templateId,
          slotId: legacyTake.templateId,
          sourceTemplateId: legacyTake.template.id || legacyTake.templateId,
          layerId: 50,
          waitingContinue: false,
        }],
      },
    });

    manager.setWaitingContinue(channelId, legacyTake.templateId, true);
    assert.deepEqual(manager.onAirTemplateIds(), {
      [channelId]: [legacyTake.templateId],
    });
    assert.deepEqual(manager.onAirDetails(), {
      schemaVersion: 'onair-details-v1',
      channels: {
        [channelId]: [{
          templateId: legacyTake.templateId,
          slotId: legacyTake.templateId,
          sourceTemplateId: legacyTake.template.id || legacyTake.templateId,
          layerId: 50,
          waitingContinue: true,
        }],
      },
    });
  } finally {
    db.close();
  }
});

test('update after take still merges variables without a z-order bump', () => {
  const db = openDb(':memory:');
  try {
    const dao = onAirDao(db);
    const manager = new OnAirManager(db);
    const legacyTake = takeCommand(readFixture('old', 'test'));
    legacyTake.variables = { name: 'A' };
    manager.handleControlCommand(legacyTake);
    const orderAfterTake = orderIndex(db, legacyTake.templateId);

    manager.handleControlCommand({
      type: 'update',
      channelId,
      templateId: legacyTake.templateId,
      variables: { title: 'B' },
    });

    const stored = dao.get(channelId, legacyTake.templateId);
    assert.deepEqual(stored.variables, { name: 'A', title: 'B' });
    assert.equal(orderIndex(db, legacyTake.templateId), orderAfterTake);
  } finally {
    db.close();
  }
});

test('normalizeRendererMessage accepts endScene', () => {
  const result = normalizeRendererMessage({
    type: 'endScene',
    templateId: 'tpl-1',
    ended: true,
    extra: 1,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    type: 'endScene',
    templateId: 'tpl-1',
    ended: true,
  });
});

test('renderer endScene clears the on-air take', () => {
  const db = openDb(':memory:');
  try {
    const manager = new OnAirManager(db);
    const fixture = readFixture('old', 'test');
    manager.handleControlCommand(takeCommand(fixture));
    const applied = applyRendererMessage(manager, channelId, {
      type: 'endScene',
      templateId: fixture.id,
      ended: true,
    });
    assert.equal(applied.ok, true);
    assert.deepEqual(manager.onAirTemplateIds(), {});
  } finally {
    db.close();
  }
});

test('normalizeRendererMessage accepts waitingContinue', () => {
  const result = normalizeRendererMessage({
    type: 'waitingContinue',
    templateId: 'tpl-1',
    waiting: true,
    extra: 1,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    type: 'waitingContinue',
    templateId: 'tpl-1',
    waiting: true,
  });
});

test('renderer waitingContinue updates details without persisting', () => {
  const db = openDb(':memory:');
  try {
    const dao = onAirDao(db);
    const manager = new OnAirManager(db);
    const fixture = readFixture('old', 'test');
    manager.handleControlCommand(takeCommand(fixture));
    const applied = applyRendererMessage(manager, channelId, {
      type: 'waitingContinue',
      templateId: fixture.id,
      waiting: true,
    });
    assert.equal(applied.ok, true);
    assert.equal(manager.isWaitingContinue(channelId, fixture.id), true);
    assert.equal(manager.onAirDetails().channels[channelId][0].waitingContinue, true);
    assert.equal('waitingContinue' in (dao.get(channelId, fixture.id) ?? {}), false);
  } finally {
    db.close();
  }
});
