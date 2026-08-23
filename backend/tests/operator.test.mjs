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

test('LayerID setting default OFF; when ON same layer replaces occupant', () => {
  const db = openDb(':memory:');
  const manager = new OnAirManager(db);
  const renderer = { readyState: 1, send() {}, close() {} };
  manager.registerRenderer('ch1', renderer);
  const a = { type: 'take', channelId: 'ch1', templateId: 'slot-a', template: oldTest };
  const b = { type: 'take', channelId: 'ch1', templateId: 'slot-b', template: oldTest };
  manager.handleControlCommand(a);
  manager.handleControlCommand(b);
  assert.deepEqual(manager.onAirTemplateIds().ch1, ['slot-a', 'slot-b']);

  db.prepare(`INSERT INTO settings (key, value) VALUES ('layerIdPlayout', 'on')`).run();
  const managerOn = new OnAirManager(db);
  managerOn.registerRenderer('ch1', renderer);
  managerOn.handleControlCommand(a);
  managerOn.handleControlCommand(b);
  assert.deepEqual(managerOn.onAirTemplateIds().ch1, ['slot-b']);
  const details = managerOn.onAirDetails();
  assert.equal(details.channels.ch1[0].layerId, 50);
  assert.equal(details.channels.ch1[0].slotId, 'slot-b');
  assert.equal(managerOn.onAirTemplateIds().ch1[0], 'slot-b');
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
