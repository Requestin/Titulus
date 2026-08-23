import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { openDb, templatesDao } from '../src/db.js';
import { templatesRouter } from '../src/routes/templates.js';

const fixturesDirectory = fileURLToPath(
  new URL('../../tests/fixtures/p21/', import.meta.url),
);
const sharedSchemaPath = fileURLToPath(
  new URL('../../shared/template.schema.json', import.meta.url),
);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readFixture(kind, id) {
  return readJson(`${fixturesDirectory}/${kind}/${id}.json`);
}

function legacyTemplateWithActions({ declareCapability = false } = {}) {
  const template = readFixture('old', 'test1');
  if (declareCapability) {
    template.capabilities = ['timeline.action-cues-items'];
  }
  template.timeline.actions = [
    {
      id: 'start-default',
      directorId: 'default',
      frame: 25,
      command: 'startDirector',
      targetDirectorId: 'default',
    },
    {
      id: 'stop-default',
      directorId: 'default',
      frame: 25,
      command: 'stopDirector',
      targetDirectorId: 'default',
    },
    {
      id: 'end-scene',
      directorId: 'default',
      frame: 100,
      command: 'setTag',
      tag: 'End scene',
    },
  ];
  return template;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function withTemplateServer(run) {
  const db = openDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api/templates', templatesRouter(db));
  const server = app.listen(0, '127.0.0.1');

  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await run({
      db,
      baseUrl: `http://127.0.0.1:${address.port}/api/templates`,
    });
  } finally {
    try {
      await closeServer(server);
    } finally {
      db.close();
    }
  }
}

async function requestJson(baseUrl, path = '', { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

function assertClassicDataUnchanged(actual, expected) {
  assert.deepEqual(actual.canvas, expected.canvas);
  assert.deepEqual(
    actual.groups.map(({ transform }) => transform),
    expected.groups.map(({ transform }) => transform),
  );
  assert.deepEqual(
    actual.layers.map(({ transform }) => transform),
    expected.layers.map(({ transform }) => transform),
  );
  assert.deepEqual(actual.rootStack, expected.rootStack);
  assert.deepEqual(actual.groupStacks, expected.groupStacks);
  assert.deepEqual(actual.timeline.keyframes, expected.timeline.keyframes);
}

function assertUnsupportedCapabilities(body, expectedCapabilities) {
  assert.equal(body.error.code, 'TEMPLATE_VALIDATION_FAILED');
  assert.equal(typeof body.error.message, 'string');
  assert.ok(body.error.details.count > 0);
  const error = body.error.details.errors.find(
    ({ code }) => code === 'UNSUPPORTED_TEMPLATE_CAPABILITY',
  );
  assert.ok(error, JSON.stringify(body));
  assert.equal(error.path, '/capabilities');
  assert.match(error.message, /unsupported template capabilities/i);
  assert.deepEqual(error.capabilities, [...expectedCapabilities].sort());
}

test('GET /schema returns the exact shared template schema JSON', async () => {
  await withTemplateServer(async ({ baseUrl }) => {
    const result = await requestJson(baseUrl, '/schema');

    assert.equal(result.status, 200);
    assert.deepEqual(result.body, readJson(sharedSchemaPath));
  });
});

test('old fixture survives POST, GET and PUT with classic geometry and timeline intact', async () => {
  await withTemplateServer(async ({ baseUrl }) => {
    const fixture = readFixture('old', 'test1');

    const created = await requestJson(baseUrl, '', {
      method: 'POST',
      body: { name: 'old fixture', data: fixture },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(created.body.data, fixture);
    assertClassicDataUnchanged(created.body.data, fixture);

    const fetched = await requestJson(baseUrl, `/${encodeURIComponent(fixture.id)}`);
    assert.equal(fetched.status, 200, JSON.stringify(fetched.body));
    assert.deepEqual(fetched.body.data, fixture);
    assertClassicDataUnchanged(fetched.body.data, fixture);

    const changed = structuredClone(fixture);
    changed.variables[0].defaultValue = 'UPDATED VALUE';
    const updated = await requestJson(baseUrl, `/${encodeURIComponent(fixture.id)}`, {
      method: 'PUT',
      body: { name: 'renamed old fixture', data: changed },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.name, 'renamed old fixture');
    assert.deepEqual(updated.body.data, changed);
    assertClassicDataUnchanged(updated.body.data, fixture);

    const fetchedAfterUpdate = await requestJson(baseUrl, `/${encodeURIComponent(fixture.id)}`);
    assert.equal(fetchedAfterUpdate.status, 200, JSON.stringify(fetchedAfterUpdate.body));
    assert.equal(fetchedAfterUpdate.body.data.variables[0].defaultValue, 'UPDATED VALUE');
    assert.deepEqual(fetchedAfterUpdate.body.data, changed);
  });
});

test('POST /validate accepts an old fixture for production', async () => {
  await withTemplateServer(async ({ baseUrl }) => {
    const result = await requestJson(baseUrl, '/validate', {
      method: 'POST',
      body: readFixture('old', 'test'),
    });

    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body, { valid: true, errors: [] });
  });
});

test('allowlisted draft validate and create persist the vNext template', async () => {
  await withTemplateServer(async ({ baseUrl, db }) => {
    const fixture = readFixture('draft', 'scene-pivot-z');

    const validated = await requestJson(baseUrl, '/validate', {
      method: 'POST',
      body: fixture,
    });
    assert.equal(validated.status, 200, JSON.stringify(validated.body));
    assert.deepEqual(validated.body, { valid: true, errors: [] });

    const created = await requestJson(baseUrl, '', {
      method: 'POST',
      body: { name: fixture.name, data: fixture },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(created.body.data.capabilities, fixture.capabilities);
    assert.ok(templatesDao(db).get(fixture.id));
  });
});

test('LayerID draft validate and create persist the vNext template', async () => {
  await withTemplateServer(async ({ baseUrl, db }) => {
    const fixture = readFixture('draft', 'layer-id-stack-a');

    const validated = await requestJson(baseUrl, '/validate', {
      method: 'POST',
      body: fixture,
    });
    assert.equal(validated.status, 200, JSON.stringify(validated.body));
    assert.deepEqual(validated.body, { valid: true, errors: [] });

    const created = await requestJson(baseUrl, '', {
      method: 'POST',
      body: { name: fixture.name, data: fixture },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(created.body.data.capabilities, fixture.capabilities);
    assert.ok(templatesDao(db).get(fixture.id));
  });
});

test('unknown capability validate and create return no row', async () => {
  await withTemplateServer(async ({ baseUrl, db }) => {
    const fixture = structuredClone(readFixture('old', 'test'));
    fixture.capabilities = ['future.unregistered-capability'];

    const validated = await requestJson(baseUrl, '/validate', {
      method: 'POST',
      body: fixture,
    });
    assert.equal(validated.status, 422, JSON.stringify(validated.body));
    assert.equal(validated.body.valid, false);

    const created = await requestJson(baseUrl, '', {
      method: 'POST',
      body: { name: fixture.name, data: fixture },
    });
    assert.equal(created.status, 422, JSON.stringify(created.body));
    assert.equal(templatesDao(db).get(fixture.id), null);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM templates').get().count, 0);
  });
});

test('legacy flat actions convert on create and get', async () => {
  await withTemplateServer(async ({ baseUrl }) => {
    const fixture = legacyTemplateWithActions();

    const created = await requestJson(baseUrl, '', {
      method: 'POST',
      body: { name: 'classic flat actions', data: fixture },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(created.body.data.timeline.actions, []);
    assert.equal(created.body.data.timeline.cues.length, 2);
    assert.ok(created.body.data.capabilities.includes('timeline.action-cues-items'));
    assertClassicDataUnchanged(created.body.data, fixture);

    const fetched = await requestJson(baseUrl, `/${encodeURIComponent(fixture.id)}`);
    assert.equal(fetched.status, 200, JSON.stringify(fetched.body));
    assert.deepEqual(fetched.body.data, created.body.data);
  });
});

test('capability-marked flat actions migrate on read without rewrite, then persist on save', async () => {
  await withTemplateServer(async ({ baseUrl, db }) => {
    const legacy = legacyTemplateWithActions({ declareCapability: true });
    const dao = templatesDao(db);
    dao.create({ id: legacy.id, name: 'seeded marked legacy', data: legacy });
    const rowBefore = db.prepare(
      'SELECT name, data FROM templates WHERE id = ?',
    ).get(legacy.id);

    const firstRead = await requestJson(baseUrl, `/${encodeURIComponent(legacy.id)}`);
    const secondRead = await requestJson(baseUrl, `/${encodeURIComponent(legacy.id)}`);
    assert.equal(firstRead.status, 200, JSON.stringify(firstRead.body));
    assert.equal(secondRead.status, 200, JSON.stringify(secondRead.body));
    assert.deepEqual(secondRead.body.data, firstRead.body.data);
    assert.deepEqual(firstRead.body.data.timeline.actions, []);
    assert.deepEqual(firstRead.body.data.capabilities, ['timeline.action-cues-items']);
    assert.equal(firstRead.body.data.timeline.cues.length, 2);
    assertClassicDataUnchanged(firstRead.body.data, legacy);

    const [directorCue, tagCue] = firstRead.body.data.timeline.cues;
    assert.equal(typeof directorCue.id, 'string');
    assert.equal(typeof tagCue.id, 'string');
    assert.deepEqual(
      {
        directorId: directorCue.directorId,
        frame: directorCue.frame,
        commands: directorCue.items.map(({ command }) => command),
        targets: directorCue.items.map(({ parameterDirectorId }) => parameterDirectorId),
      },
      {
        directorId: 'default',
        frame: 25,
        commands: ['startDirector', 'stopDirector'],
        targets: ['default', 'default'],
      },
    );
    assert.deepEqual(
      {
        directorId: tagCue.directorId,
        frame: tagCue.frame,
        command: tagCue.items[0].command,
        parameterTag: tagCue.items[0].parameterTag,
      },
      {
        directorId: 'default',
        frame: 100,
        command: 'tag',
        parameterTag: 'endScene',
      },
    );
    assert.deepEqual(
      db.prepare('SELECT name, data FROM templates WHERE id = ?').get(legacy.id),
      rowBefore,
      'GET migration must not rewrite the seeded record',
    );

    const validated = await requestJson(baseUrl, '/validate', {
      method: 'POST',
      body: legacy,
    });
    assert.equal(validated.status, 200, JSON.stringify(validated.body));
    assert.deepEqual(validated.body, { valid: true, errors: [] });

    const createCandidate = { ...legacy, id: 'marked-actions-create-candidate' };
    const created = await requestJson(baseUrl, '', {
      method: 'POST',
      body: { name: 'converted actions', data: createCandidate },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(created.body.data.timeline.actions, []);
    assert.ok(created.body.data.capabilities.includes('timeline.action-cues-items'));
    assert.ok(dao.get(createCandidate.id));

    const updated = await requestJson(baseUrl, `/${encodeURIComponent(legacy.id)}`, {
      method: 'PUT',
      body: { name: 'converted seeded', data: legacy },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.name, 'converted seeded');
    assert.deepEqual(updated.body.data.timeline.actions, []);
    assert.ok(updated.body.data.capabilities.includes('timeline.action-cues-items'));
    assertClassicDataUnchanged(updated.body.data, legacy);
  });
});
