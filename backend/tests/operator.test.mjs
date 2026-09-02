import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import { openDb, onAirDao, templatesDao } from '../src/db.js';
import { OnAirManager } from '../src/onair.js';
import { mediaLibraryDao } from '../src/mediaLibrary.js';
import { dataElementsDao, rbacDao, templateFoldersDao, templateLocksDao, STALE_LOCK_MS } from '../src/operatorTables.js';
import { createAuth } from '../src/auth.js';
import { authRouter } from '../src/routes/auth.js';
import { templateFoldersRouter } from '../src/routes/templateFolders.js';
import { dataElementsRouter } from '../src/routes/dataElements.js';
import { rundownsRouter } from '../src/routes/rundowns.js';
import { templatesRouter } from '../src/routes/templates.js';
import { readFileSync } from 'node:fs';

const oldTest = JSON.parse(readFileSync(new URL('../../tests/fixtures/p21/old/test.json', import.meta.url), 'utf8'));

test('copied DB gains catalog tables and backfills ready media', () => {
  const db = openDb(':memory:');
  db.prepare(`
    INSERT INTO media_assets (
      id, type, status, original_name, source_mime, source_size_bytes,
      source_filename, playback_filename, poster_filename
    ) VALUES ('ready-1', 'image', 'ready', 'hero.png', 'image/png', 1, 'a.png', 'a.webp', 'a.jpg')
  `).run();
  mediaLibraryDao(db).backfillReady();
  const listed = mediaLibraryDao(db).list();
  assert.equal(listed[0].mediaAssetId, 'ready-1');
  assert.equal(listed[0].token, 'asset:ready-1');
  db.close();
});

test('folders unfile by default and hide_in_control is stored', () => {
  const db = openDb(':memory:');
  const folders = templateFoldersDao(db);
  const created = templatesDao(db).create({ id: 't1', name: 'One', data: oldTest });
  const folder = folders.create({ name: 'News', hideInControl: true });
  assert.equal(folder.hide_in_control, 1);
  assert.equal(folders.setTemplateFolder(created.id, folder.id), true);
  assert.equal(templatesDao(db).get(created.id).folder_id, folder.id);
  folders.remove(folder.id);
  assert.equal(templatesDao(db).get(created.id).folder_id, null);
  assert.ok(templatesDao(db).get(created.id));
  db.close();
});

test('data elements cascade when the template is deleted', () => {
  const db = openDb(':memory:');
  templatesDao(db).create({ id: 't-de', name: 'DE', data: oldTest });
  const row = dataElementsDao(db).create({ name: 'Morning', templateId: 't-de', payload: { a: 1 } });
  assert.equal(row.templateId, 't-de');
  templatesDao(db).remove('t-de');
  assert.equal(dataElementsDao(db).get(row.id), null);
  db.close();
});

test('template locks expire after 90s and only the owner may refresh', () => {
  const db = openDb(':memory:');
  templatesDao(db).create({ id: 'locked', name: 'L', data: oldTest });
  const locks = templateLocksDao(db);
  const first = locks.acquire({ templateId: 'locked', userId: 'u1', username: 'ann', token: 'tok-a' });
  assert.equal(first.ok, true);
  const denied = locks.acquire({ templateId: 'locked', userId: 'u2', username: 'bob', token: 'tok-b' });
  assert.equal(denied.ok, false);
  assert.equal(locks.heartbeat({ templateId: 'locked', token: 'tok-b' }), null);
  db.prepare(`UPDATE template_locks SET heartbeat_at = ? WHERE template_id = 'locked'`).run(
    new Date(Date.now() - STALE_LOCK_MS - 1000).toISOString(),
  );
  const recovered = locks.acquire({ templateId: 'locked', userId: 'u2', username: 'bob', token: 'tok-b' });
  assert.equal(recovered.ok, true);
  db.close();
});

test('admin keeps all groups; operator has control and files.read; no UE group', () => {
  const db = openDb(':memory:');
  const auth = createAuth(db);
  const admin = auth.dao.listUsers().find((user) => user.role === 'admin');
  const perms = rbacDao(db).permissionsForUser(admin.id, 'admin');
  assert.deepEqual(perms, ['template_editor', 'control', 'settings', 'files.read']);
  const created = auth.dao.createUser({
    tenantId: admin.tenant_id,
    username: 'op1',
    passwordHash: admin.password_hash || 'x',
    passwordSalt: '00',
    role: 'operator',
  });
  rbacDao(db).assignDefaults(created.id, 'operator');
  assert.deepEqual(rbacDao(db).permissionsForUser(created.id, 'operator'), ['control', 'files.read']);
  const groups = db.prepare('SELECT id FROM permission_groups').all().map((row) => row.id);
  assert.ok(!groups.includes('ue') && !groups.includes('unreal'));
  db.close();
});

test('LayerID playout default ON; OFF stacks same layer, ON replaces occupant', () => {
  const db = openDb(':memory:');
  const renderer = { readyState: 1, send() {}, close() {} };
  const a = { type: 'take', channelId: 'ch1', templateId: 'slot-a', template: oldTest };
  const b = { type: 'take', channelId: 'ch1', templateId: 'slot-b', template: oldTest };

  const manager = new OnAirManager(db);
  manager.registerRenderer('ch1', renderer);
  manager.handleControlCommand(a);
  manager.handleControlCommand(b);
  assert.deepEqual(manager.onAirTemplateIds().ch1, ['slot-b']);
  assert.equal(manager.onAirDetails().channels.ch1[0].layerId, 50);

  db.prepare(`INSERT INTO settings (key, value) VALUES ('layerIdPlayout', 'off')`).run();
  const managerOff = new OnAirManager(db);
  managerOff.registerRenderer('ch1', renderer);
  managerOff.handleControlCommand(a);
  managerOff.handleControlCommand(b);
  assert.deepEqual(managerOff.onAirTemplateIds().ch1, ['slot-a', 'slot-b']);
  assert.deepEqual(
    managerOff.onAirDetails().channels.ch1.map((item) => item.layerId),
    [50, 50],
  );

  managerOff.handleControlCommand({ type: 'clear', channelId: 'ch1' });
  db.prepare(`UPDATE settings SET value = 'on' WHERE key = 'layerIdPlayout'`).run();
  const withLayer = (templateId, layerId) => ({
    type: 'take',
    channelId: 'ch1',
    templateId,
    template: {
      ...oldTest,
      layerId,
      capabilities: ['control.layer-id-on-air'],
    },
  });
  const managerOn = new OnAirManager(db);
  managerOn.registerRenderer('ch1', renderer);
  managerOn.handleControlCommand(withLayer('low', 10));
  managerOn.handleControlCommand(withLayer('high', 90));
  managerOn.handleControlCommand(withLayer('low-replace', 10));
  assert.deepEqual(managerOn.onAirTemplateIds().ch1, ['high', 'low-replace']);
  assert.deepEqual(
    managerOn.onAirDetails().channels.ch1.map((item) => item.layerId),
    [90, 10],
  );
  db.close();
});

test('same-layer re-TAKE of a template with Update tracks fans UPDATE, not clear+take', async () => {
  const db = openDb(':memory:');
  const cues = JSON.parse(readFileSync(new URL('../../tests/fixtures/p21/draft/timeline-action-cues.json', import.meta.url), 'utf8'));
  const withUpdateTracks = {
    ...cues,
    id: 'geo-src',
    timeline: {
      ...cues.timeline,
      keyframes: [
        ...(cues.timeline.keyframes || []),
        {
          id: 'upd-x',
          frame: 0,
          directorId: 'update',
          layers: { text: { x: 10 } },
          groups: {},
          easing: 'linear',
        },
      ],
    },
  };
  const renderer = {
    readyState: 1,
    messages: [],
    send(payload) { this.messages.push(JSON.parse(payload)); },
  };
  const manager = new OnAirManager(db);
  manager.registerRenderer('ch1', renderer);

  await manager.handleControlCommand({
    type: 'take',
    channelId: 'ch1',
    templateId: 'slot-spb',
    template: withUpdateTracks,
    variables: { city: 'Санкт-Петербург' },
  });
  renderer.messages.length = 0;

  await manager.handleControlCommand({
    type: 'take',
    channelId: 'ch1',
    templateId: 'slot-msk',
    slotId: 'slot-msk',
    template: withUpdateTracks,
    variables: { city: 'москва' },
  });

  assert.deepEqual(manager.onAirTemplateIds().ch1, ['slot-spb']);
  assert.equal(manager.onAirDetails().channels.ch1[0].slotId, 'slot-msk');
  assert.equal(manager.onAirDetails().channels.ch1[0].sourceTemplateId, 'geo-src');
  assert.equal(renderer.messages.length, 1);
  assert.equal(renderer.messages[0].type, 'update');
  assert.equal(renderer.messages[0].templateId, 'slot-spb');
  assert.equal(renderer.messages[0].variables.city, 'москва');
  db.close();
});

test('rundown rejects kind:ue and keeps legacy slots', async () => {
  const db = openDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api/rundowns', rundownsRouter(db));
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const { port } = server.address();
    const rejected = await fetch(`http://127.0.0.1:${port}/api/rundowns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'UE', slots: [{ templateId: 't', kind: 'ue' }] }),
    });
    assert.equal(rejected.status, 422);
    const created = await fetch(`http://127.0.0.1:${port}/api/rundowns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'News', slots: [{ templateId: 't', name: 'A', vars: { x: '1' } }] }),
    });
    assert.equal(created.status, 201);
    const body = await created.json();
    assert.equal(body.slots[0].templateId, 't');
    assert.equal(body.slots[0].dataElementId, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});


test("RBAC groups API lists seeded groups and assigns operator permissions", async () => {
  const db = openDb(":memory:");
  const app = express();
  app.use(express.json());
  const auth = createAuth(db);
  app.use("/api/auth", authRouter(auth));
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const { port } = server.address();
    const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin123" }),
    });
    const { token } = await login.json();
    const groups = await fetch(`http://127.0.0.1:${port}/api/auth/groups`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(groups.status, 200);
    const listed = await groups.json();
    assert.ok(listed.includes("control") && listed.includes("template_editor"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
