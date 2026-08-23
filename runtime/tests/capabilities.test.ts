import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { classifyTemplateCapabilities } from '../src/capabilities.js';
import { normalizeTemplate } from '../src/normalizeTemplate.js';
import type { Template } from '../src/schema.js';

const fixturesDirectory = fileURLToPath(
  new URL('../../tests/fixtures/p21/', import.meta.url),
);
const oldDirectory = join(fixturesDirectory, 'old');
const draftDirectory = join(fixturesDirectory, 'draft');
const expectedDirectory = join(fixturesDirectory, 'expected');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readTemplate(kind: 'old' | 'draft', id: string): Template {
  return readJson(join(fixturesDirectory, kind, `${id}.json`)) as Template;
}

function fixtureIds(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
}

for (const kind of ['old', 'draft'] as const) {
  const directory = kind === 'old' ? oldDirectory : draftDirectory;
  for (const id of fixtureIds(directory)) {
    test(`${kind} fixture ${id} matches its exact capability golden`, () => {
      const template = readTemplate(kind, id);
      const expected = readJson(
        join(expectedDirectory, `${id}.capabilities.json`),
      );

      const actual = classifyTemplateCapabilities(template);

      assert.deepEqual(actual, expected);
      assert.equal(
        actual.airCompatible,
        actual.required.every((capability) => actual.supported.includes(capability)),
      );
    });
  }
}

for (const id of fixtureIds(oldDirectory)) {
  test(`normalizeTemplate preserves old fixture ${id} deep-semantically`, () => {
    const template = readTemplate('old', id);
    const snapshot = structuredClone(template);

    const once = normalizeTemplate(template);
    const twice = normalizeTemplate(once);

    assert.deepEqual(template, snapshot, 'normalization mutated its input');
    assert.notStrictEqual(once, template, 'normalization must return a detached value');
    assert.deepEqual(once, snapshot, 'legacy fixture changed semantically');
    assert.deepEqual(twice, once, 'normalization must be idempotent');
  });
}

test('capability classifier detects a missing declaration', () => {
  const template = readTemplate('draft', 'scene-pivot-z');
  template.capabilities = template.capabilities?.filter(
    (capability) => capability !== 'properties.position-z',
  );

  assert.throws(
    () => classifyTemplateCapabilities(template),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /missing/i);
      assert.match(error.message, /properties\.position-z/);
      return true;
    },
  );
});

test('capability classifier detects an unknown declaration', () => {
  const template = readTemplate('old', 'test');
  (template as unknown as { capabilities: string[] }).capabilities = [
    'future.unregistered-capability',
  ];

  assert.throws(
    () => classifyTemplateCapabilities(template),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /unknown/i);
      assert.match(error.message, /future\.unregistered-capability/);
      return true;
    },
  );
});
