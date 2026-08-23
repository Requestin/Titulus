import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import { openDb } from '../src/db.js';
import { templatesRouter } from '../src/routes/templates.js';

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test('POST /prepare returns overrides and blocks onError=block', async () => {
  const db = openDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api/templates', templatesRouter(db, { dataDir: '/tmp/titulus-missing' }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const { port } = server.address();
    const template = {
      name: 'Prep',
      canvas: { width: 1920, height: 1080, background: '#000000' },
      variables: [{ id: 'title', name: 'Title', label: 'Title', type: 'text', defaultValue: 'old' }],
      groups: [],
      layers: [],
      rootStack: [],
      groupStacks: {},
      timeline: { fps: 50, durationFrames: 100, playbackMode: 'bounded', directors: [], trackDirectors: {}, keyframes: [], actions: [] },
      data: {
        version: 1,
        onError: 'block',
        sources: [{ id: 'src', type: 'inline', format: 'lines', content: 'Alpha' }],
        pipelines: [{
          id: 'pipe',
          sourceId: 'src',
          select: { mode: 'first' },
          map: [{ from: 'line', to: { type: 'variable', variableId: 'title' } }],
        }],
      },
    };
    const ok = await fetch(`http://127.0.0.1:${port}/api/templates/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ template, trigger: 'take' }),
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.equal(body.overrides.title, 'Alpha');

    template.data.pipelines[0].sourceId = 'missing';
    const blocked = await fetch(`http://127.0.0.1:${port}/api/templates/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ template, trigger: 'take' }),
    });
    assert.equal(blocked.status, 200);
    const failed = await blocked.json();
    assert.equal(failed.blocked, true);
  } finally {
    await closeServer(server);
    db.close();
  }
});
