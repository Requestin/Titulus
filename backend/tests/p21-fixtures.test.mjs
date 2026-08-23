import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateTemplate } from '../src/templateValidation.js';

const testsDirectory = fileURLToPath(new URL('../../tests/', import.meta.url));
const templatesDirectory = join(testsDirectory, 'templates');
const fixturesDirectory = join(testsDirectory, 'fixtures', 'p21');
const oldDirectory = join(fixturesDirectory, 'old');
const draftDirectory = join(fixturesDirectory, 'draft');
const expectedDirectory = join(fixturesDirectory, 'expected');

const oldFixtureIds = [
  'test',
  'test1',
  'p20-test1-visual',
];

const draftFixtureIds = [
  'scene-pivot-z',
  'text-transform-shadow',
  'rect-gradient-static',
  'rect-gradient-animated',
  'crawl-ticker',
  'crawl-carousel',
  'timeline-action-cues',
  'data-pipeline-matrix',
  'data-error-keep',
  'data-error-clear',
  'layer-id-stack-a',
  'layer-id-stack-b',
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

for (const id of oldFixtureIds) {
  test(`P21 old fixture ${id} is byte-identical to its template`, () => {
    const fixture = readFileSync(join(oldDirectory, `${id}.json`));
    const template = readFileSync(join(templatesDirectory, `${id}.json`));

    assert.deepEqual(fixture, template);
  });

  test(`P21 old fixture ${id} remains valid under the current schema`, () => {
    const fixture = readJson(join(oldDirectory, `${id}.json`));
    const result = validateTemplate(fixture);

    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  test(`P21 old fixture ${id} normalizes without semantic changes`, () => {
    const fixture = readJson(join(oldDirectory, `${id}.json`));
    const normalized = readJson(join(expectedDirectory, `${id}.normalized.json`));

    assert.deepEqual(normalized, fixture);
  });

  test(`P21 old fixture ${id} needs no new capabilities`, () => {
    const capabilities = readJson(join(expectedDirectory, `${id}.capabilities.json`));

    assert.deepEqual(capabilities, {
      schemaVersion: 'p21-capabilities-v1',
      required: [],
      supported: [],
      airCompatible: true,
    });
  });
}

test('P21 draft fixture IDs exactly match the required contract inventory', () => {
  const actualIds = readdirSync(draftDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name.slice(0, -'.json'.length))
    .sort();

  assert.deepEqual(actualIds, [...draftFixtureIds].sort());
});

for (const id of draftFixtureIds) {
  test(`P21 draft fixture ${id} parses but current validation rejects it`, () => {
    const fixture = readJson(join(draftDirectory, `${id}.json`));
    const fixtureWithoutCapabilities = { ...fixture };
    delete fixtureWithoutCapabilities.capabilities;
    const result = validateTemplate(fixtureWithoutCapabilities);

    assert.equal(result.valid, false);
  });

  test(`P21 draft fixture ${id} has its unchanged normalized golden`, () => {
    const fixture = readJson(join(draftDirectory, `${id}.json`));
    const normalized = readJson(join(expectedDirectory, `${id}.normalized.json`));

    assert.deepEqual(normalized, fixture);
  });

  test(`P21 draft fixture ${id} is classified as unsupported for air`, () => {
    const fixture = readJson(join(draftDirectory, `${id}.json`));
    const capabilities = readJson(join(expectedDirectory, `${id}.capabilities.json`));

    assert.equal(capabilities.schemaVersion, 'p21-capabilities-v1');
    assert.deepEqual(capabilities.required, [...fixture.capabilities].sort());
    assert.deepEqual(capabilities.supported, []);
    assert.equal(capabilities.airCompatible, false);
  });
}
