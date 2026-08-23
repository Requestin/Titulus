import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { createAuth } from '../src/auth.js';
import { openDb } from '../src/db.js';
import { authRouter } from '../src/routes/auth.js';
import { filesRouter } from '../src/routes/files.js';
import { ensureDataFilesDir } from '../src/filesAccess.js';

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function withFilesServer(run, env = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'titulus-p21-files-api-'));
  ensureDataFilesDir(dataDir);
  const db = openDb(join(dataDir, 'app.db'));
  const auth = createAuth(db);
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter(auth));
  app.use('/api/files', auth.requireAuth, filesRouter({ db, dataDir, env }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    const session = await login.json();
    await run({
      base,
      token: session.token,
      dataDir,
      headers: { authorization: `Bearer ${session.token}` },
    });
  } finally {
    await closeServer(server);
    db.close();
  }
}

test('unauthenticated files access is rejected', async () => {
  await withFilesServer(async ({ base }) => {
    const res = await fetch(`${base}/api/files/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/data-files/x.txt' }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, 'AUTH_REQUIRED');
  });
});

test('allowlisted upload then read succeeds', async () => {
  await withFilesServer(async ({ base, headers }) => {
    const form = new FormData();
    form.set('file', new Blob(['hello crawl'], { type: 'text/plain' }), 'crawl.txt');
    const uploaded = await fetch(`${base}/api/files`, { method: 'POST', headers, body: form });
    assert.equal(uploaded.status, 201);
    const row = await uploaded.json();
    assert.match(row.path, /^\/data-files\/.+\.txt$/);

    const read = await fetch(`${base}/api/files/read`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ path: row.path }),
    });
    assert.equal(read.status, 200);
    assert.equal((await read.json()).text, 'hello crawl');
  });
});

test('forbidden read does not leak roots', async () => {
  await withFilesServer(async ({ base, headers }) => {
    const res = await fetch(`${base}/api/files/read`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/etc/passwd' }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error.code, 'PATH_NOT_ALLOWED');
    assert.equal(body.error.details, undefined);
    assert.doesNotMatch(JSON.stringify(body), /\/etc|data-files|TITULUS_FILE_ROOTS/);
  });
});

test('explicit extra root can be read; default extra roots stay empty', async () => {
  const extra = mkdtempSync(join(tmpdir(), 'titulus-extra-root-'));
  writeFileSync(join(extra, 'wire.txt'), 'from-root');
  await withFilesServer(async ({ base, headers }) => {
    const denied = await fetch(`${base}/api/files/read`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ path: join(extra, 'wire.txt') }),
    });
    assert.equal(denied.status, 403);
  }, {});
  await withFilesServer(async ({ base, headers }) => {
    const ok = await fetch(`${base}/api/files/read`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ path: join(extra, 'wire.txt') }),
    });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).text, 'from-root');
  }, { TITULUS_FILE_ROOTS: extra });
});
