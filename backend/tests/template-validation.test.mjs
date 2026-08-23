import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  validateTemplate,
  validateTemplateForAir,
  validateTemplateSchema,
} from '../src/templateValidation.js';
import { classifyTemplateCapabilities } from '../../shared/templateCapabilities.mjs';
import { normalizeControlMessage } from '../src/routes/ws.js';

const fixturesDirectory = fileURLToPath(
  new URL('../../tests/fixtures/p21/', import.meta.url),
);
const oldDirectory = join(fixturesDirectory, 'old');
const draftDirectory = join(fixturesDirectory, 'draft');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fixtureIds(directory) {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
}

function assertUnsupportedForAir(result, id) {
  assert.equal(result.valid, false, `${id} unexpectedly passed air validation`);
  assert.ok(
    result.errors.some((error) =>
      error.code === 'UNSUPPORTED_TEMPLATE_CAPABILITY'
      || /unsupported/i.test(error.message)),
    `${id} lacks an explicit unsupported-capability error: ${JSON.stringify(result.errors)}`,
  );
}

test('raw schema validation accepts old and draft fixtures', () => {
  for (const [kind, directory] of [
    ['old', oldDirectory],
    ['draft', draftDirectory],
  ]) {
    for (const id of fixtureIds(directory)) {
      const result = validateTemplateSchema(readJson(join(directory, `${id}.json`)));
      assert.equal(
        result.valid,
        true,
        `${kind}/${id}: ${JSON.stringify(result.errors)}`,
      );
    }
  }
});

test('production validation accepts every old fixture', () => {
  for (const id of fixtureIds(oldDirectory)) {
    const fixture = readJson(join(oldDirectory, `${id}.json`));
    const forAir = validateTemplateForAir(fixture);
    const production = validateTemplate(fixture);

    assert.equal(forAir.valid, true, `${id}: ${JSON.stringify(forAir.errors)}`);
    assert.deepEqual(production, forAir);
  }
});

test('production validation accepts air-compatible vNext drafts and rejects the rest', () => {
  for (const id of fixtureIds(draftDirectory)) {
    const fixture = readJson(join(draftDirectory, `${id}.json`));
    const forAir = validateTemplateForAir(fixture);
    const production = validateTemplate(fixture);
    const compatible = classifyTemplateCapabilities(fixture).airCompatible;

    if (compatible) {
      assert.equal(forAir.valid, true, `${id}: ${JSON.stringify(forAir.errors)}`);
    } else {
      assertUnsupportedForAir(forAir, id);
    }
    assert.deepEqual(production, forAir);
  }
});

test('normalizeControlMessage accepts legacy TAKE before on-air dispatch', () => {
  const template = readJson(join(oldDirectory, 'test.json'));
  const result = normalizeControlMessage({
    type: 'take',
    channelId: 'channel-1',
    templateId: template.id,
    template,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.value.template, template);
});

test('normalizeControlMessage accepts allowlisted vNext TAKE before on-air dispatch', () => {
  const template = readJson(join(draftDirectory, 'scene-pivot-z.json'));
  const result = normalizeControlMessage({
    type: 'take',
    channelId: 'channel-1',
    templateId: template.id,
    template,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
});

test('normalizeControlMessage accepts LayerID vNext TAKE before on-air dispatch', () => {
  const template = readJson(join(draftDirectory, 'layer-id-stack-a.json'));
  const result = normalizeControlMessage({
    type: 'take',
    channelId: 'channel-1',
    templateId: template.id,
    template,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
});

test('normalizeControlMessage rejects a missing inferred capability before on-air dispatch', () => {
  const template = structuredClone(readJson(join(oldDirectory, 'test.json')));
  template.layers[0].transform.z = 12;
  const result = normalizeControlMessage({
    type: 'take',
    channelId: 'channel-1',
    templateId: template.id,
    template,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'TEMPLATE_UNSUPPORTED_FOR_AIR');
  assert.match(result.message, /missing|unsupported|capabilit/i);
});
