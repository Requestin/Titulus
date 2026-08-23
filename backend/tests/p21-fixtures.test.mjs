import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateTemplateSchema } from '../src/templateValidation.js';

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

const oldTestFixture = readJson(join(oldDirectory, 'test.json'));

function cloneOldTestFixture() {
  return structuredClone(oldTestFixture);
}

function assertRejectedAt(fixture, expectedPath) {
  const result = validateTemplateSchema(fixture);

  assert.equal(result.valid, false, 'fixture unexpectedly passed validation');
  assert.ok(
    result.errors.some(({ path }) =>
      path === expectedPath || path.startsWith(`${expectedPath}/`)),
    `expected a validation error at ${expectedPath}, got ${JSON.stringify(result.errors)}`,
  );
}

function addValidCrawlLayer(fixture) {
  const source = fixture.layers[0];
  fixture.layers[0] = {
    id: source.id,
    name: 'Crawl validation target',
    type: 'crawl',
    visible: source.visible,
    locked: source.locked,
    opacity: source.opacity,
    blendMode: source.blendMode,
    transform: structuredClone(source.transform),
    groupId: source.groupId,
    content: 'First item\nSecond item',
    style: structuredClone(fixture.layers[1].style),
    crawlDirectorId: 'default',
    crawl: {
      type: 'ticker',
      directionIn: 'right',
      directionOut: 'left',
      speed: 5,
      pause: 0,
      separatorMode: 'text',
      separatorText: ' • ',
      separatorImage: '',
      animationType: 'continuous',
      useFile: false,
      filePath: '',
      maxTextLengthEnabled: false,
      maxTextLength: 80,
    },
  };
  return fixture.layers[0];
}

for (const id of oldFixtureIds) {
  test(`P21 old fixture ${id} is byte-identical to its template`, () => {
    const fixture = readFileSync(join(oldDirectory, `${id}.json`));
    const template = readFileSync(join(templatesDirectory, `${id}.json`));

    assert.deepEqual(fixture, template);
  });

  test(`P21 old fixture ${id} remains valid under the current schema`, () => {
    const fixture = readJson(join(oldDirectory, `${id}.json`));
    const result = validateTemplateSchema(fixture);

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
  test(`P21 draft fixture ${id} is valid under schema vNext`, () => {
    const fixture = readJson(join(draftDirectory, `${id}.json`));
    const result = validateTemplateSchema(fixture);

    assert.equal(result.valid, true, JSON.stringify(result.errors));
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

test('P21 schema vNext rejects an unknown capability', () => {
  const fixture = cloneOldTestFixture();
  fixture.capabilities = ['unknown.capability'];

  assertRejectedAt(fixture, '/capabilities/0');
});

for (const layerId of [0, 100]) {
  test(`P21 schema vNext rejects layerId ${layerId}`, () => {
    const fixture = cloneOldTestFixture();
    fixture.layerId = layerId;

    assertRejectedAt(fixture, '/layerId');
  });
}

test('P21 schema vNext rejects a nonnumeric Transform.z', () => {
  const fixture = cloneOldTestFixture();
  fixture.layers[0].transform.z = 'front';

  assertRejectedAt(fixture, '/layers/0/transform/z');
});

test('P21 schema vNext rejects an invalid textTransform', () => {
  const fixture = cloneOldTestFixture();
  fixture.layers[1].style.textTransform = 'capitalize';

  assertRejectedAt(fixture, '/layers/1/style/textTransform');
});

test('P21 schema vNext rejects malformed gradient weights', () => {
  const fixture = cloneOldTestFixture();
  fixture.layers[0].fillMode = 'gradient';
  fixture.layers[0].gradient = {
    topLeft: '#ef4444',
    topRight: '#3b82f6',
    bottomLeft: '#22c55e',
    bottomRight: '#eab308',
    weights: {
      topLeft: 101,
      topRight: 80,
      bottomLeft: 60,
      bottomRight: 40,
    },
  };

  assertRejectedAt(fixture, '/layers/0/gradient/weights/topLeft');
});

test('P21 schema vNext rejects a nonpositive Crawl speed', () => {
  const fixture = cloneOldTestFixture();
  const crawlLayer = addValidCrawlLayer(fixture);
  crawlLayer.crawl.speed = 0;

  assertRejectedAt(fixture, '/layers/0/crawl/speed');
});

test('P21 schema vNext rejects an invalid Crawl direction', () => {
  const fixture = cloneOldTestFixture();
  const crawlLayer = addValidCrawlLayer(fixture);
  crawlLayer.crawl.directionIn = 'diagonal';

  assertRejectedAt(fixture, '/layers/0/crawl/directionIn');
});

test('P21 schema vNext rejects a vertical direction for ticker Crawl', () => {
  const fixture = cloneOldTestFixture();
  const crawlLayer = addValidCrawlLayer(fixture);
  crawlLayer.crawl.directionIn = 'up';

  assertRejectedAt(fixture, '/layers/0/crawl/directionIn');
});

test('P21 schema vNext rejects an unsupported variable type', () => {
  const fixture = cloneOldTestFixture();
  fixture.variables.push({
    id: 'unsupported-variable',
    name: 'unsupported-variable',
    label: 'Unsupported variable',
    type: 'boolean',
    defaultValue: '',
  });

  assertRejectedAt(fixture, '/variables/0/type');
});

test('P21 schema vNext rejects a malformed data source', () => {
  const fixture = cloneOldTestFixture();
  fixture.data = {
    version: 1,
    sources: [{ id: 'broken-source', type: 'inline', format: 'lines' }],
    pipelines: [],
  };

  assertRejectedAt(fixture, '/data/sources/0');
});

test('P21 schema vNext rejects a malformed data select', () => {
  const fixture = cloneOldTestFixture();
  fixture.data = {
    version: 1,
    sources: [{
      id: 'inline-source',
      type: 'inline',
      content: 'one\ntwo',
      format: 'lines',
    }],
    pipelines: [{
      id: 'broken-select',
      sourceId: 'inline-source',
      select: { mode: 'index' },
      map: [],
    }],
  };

  assertRejectedAt(fixture, '/data/pipelines/0/select');
});

test('P21 schema vNext rejects a malformed cue item', () => {
  const fixture = cloneOldTestFixture();
  fixture.timeline.cues = [{
    id: 'broken-cue',
    directorId: 'default',
    frame: 25,
    fromEnd: false,
    name: 'Broken cue',
    items: [{
      id: 'broken-item',
      command: 'launchDirector',
      parameterDirectorId: 'default',
      lengthFrames: 0,
      direction: 'normal',
    }],
  }];

  assertRejectedAt(fixture, '/timeline/cues/0/items/0/command');
});

test('P21 schema vNext rejects a bad propertyTrackDirectors value', () => {
  const fixture = cloneOldTestFixture();
  fixture.timeline.propertyTrackDirectors = {
    [fixture.layers[0].id]: { x: 42 },
  };

  assertRejectedAt(
    fixture,
    `/timeline/propertyTrackDirectors/${fixture.layers[0].id}/x`,
  );
});
