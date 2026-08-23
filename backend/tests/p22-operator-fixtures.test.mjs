import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { classifyTemplateCapabilities } from '../../shared/templateCapabilities.mjs';
import { validateTemplateForAir, validateTemplateSchema } from '../src/templateValidation.js';

const testsDirectory = fileURLToPath(new URL('../../tests/', import.meta.url));
const operatorDirectory = join(testsDirectory, 'fixtures', 'p22', 'operator');
const expectedDirectory = join(testsDirectory, 'fixtures', 'p22', 'expected');
const mediaDirectory = join(operatorDirectory, 'media');

const operatorFixtureIds = ['newtest1', 'newtest2'];

const requiredMedia = [
  'p22-newtest-1.jpg',
  'p22-newtest-2.png',
  'p22-newtest-3.jpg',
  'p22-newtest-video1.webp',
  'p22-newtest-video2.webp',
  'p22-newtest1-crawl.txt',
];

const hostUpload = /\/uploads\/[0-9a-f]{8}-/;
const hostDataFile = /\/data-files\/[0-9a-f]{8}-/;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('P22 operator fixture IDs match the performance canon', () => {
  const actualIds = readdirSync(operatorDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name.slice(0, -'.json'.length))
    .sort();

  assert.deepEqual(actualIds, [...operatorFixtureIds].sort());
});

test('P22 operator media set is present', () => {
  for (const name of requiredMedia) {
    assert.ok(
      readFileSync(join(mediaDirectory, name)).byteLength > 0,
      `missing ${name}`,
    );
  }
});

for (const id of operatorFixtureIds) {
  test(`P22 operator fixture ${id} is valid and air-compatible`, () => {
    const fixture = readJson(join(operatorDirectory, `${id}.json`));
    const schema = validateTemplateSchema(fixture);
    const air = validateTemplateForAir(fixture);

    assert.equal(schema.valid, true, JSON.stringify(schema.errors));
    assert.equal(air.valid, true, JSON.stringify(air.errors));
  });

  test(`P22 operator fixture ${id} has stable media paths`, () => {
    const raw = readFileSync(join(operatorDirectory, `${id}.json`), 'utf8');
    assert.equal(hostUpload.test(raw), false);
    assert.equal(hostDataFile.test(raw), false);
    assert.equal(raw.includes('.webm'), false);
    assert.ok(raw.includes('/uploads/p22-newtest-'));
  });

  test(`P22 operator fixture ${id} matches normalized golden`, () => {
    const fixture = readJson(join(operatorDirectory, `${id}.json`));
    const normalized = readJson(join(expectedDirectory, `${id}.normalized.json`));
    assert.deepEqual(normalized, fixture);
  });

  test(`P22 operator fixture ${id} matches capability golden`, () => {
    const fixture = readJson(join(operatorDirectory, `${id}.json`));
    const expected = readJson(join(expectedDirectory, `${id}.capabilities.json`));
    const actual = classifyTemplateCapabilities(fixture);

    assert.deepEqual(actual, expected);
    assert.equal(expected.schemaVersion, 'p21-capabilities-v1');
    assert.deepEqual(expected.required, [...fixture.capabilities].sort());
    assert.equal(expected.airCompatible, true);
  });
}
