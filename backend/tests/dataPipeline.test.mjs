import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyDataTransform,
  extractAssetId,
  parseSource,
  resolveDataPath,
  runTemplateData,
  selectRecords,
} from '../src/dataPipeline.js';
import { parseTimeExpression } from '../src/timeExpressions.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures/p21/draft');

function loadDraft(name) {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

test('time expressions stay as strings and parse from injected now', () => {
  const now = Date.parse('2026-08-23T12:00:00.000Z');
  assert.equal(parseTimeExpression('now+5m', now), now + 5 * 60 * 1000);
  assert.equal(parseTimeExpression('now-1h', now), now - 60 * 60 * 1000);
  assert.ok(Number.isFinite(parseTimeExpression('today@18:00', now)));
  assert.equal(parseTimeExpression('1770000000000', now), 1770000000000);
  assert.equal(parseTimeExpression('not-a-time', now), undefined);
});

test('source parsers cover lines, delimited, kv and json', () => {
  assert.deepEqual(
    parseSource({ format: 'lines', options: { skipEmpty: true, trim: true } }, 'a\n\n b \n#x'),
    [{ line: 'a', index: '1' }, { line: 'b', index: '2' }, { line: '#x', index: '3' }],
  );
  assert.deepEqual(
    parseSource({ format: 'delimited', options: { delimiter: '|', hasHeader: true } }, 'id|name\n1|Alpha'),
    [{ index: '1', id: '1', name: 'Alpha' }],
  );
  assert.deepEqual(
    parseSource({ format: 'kv', options: { kvSeparator: '=' } }, 'title=Live\nslug=breaking-news'),
    [{ index: '1', title: 'Live', slug: 'breaking-news' }],
  );
  assert.equal(
    parseSource({ format: 'json', options: { rootPath: '/items' } }, '{"items":[{"id":"2","title":"Two"}]}')[0].title,
    'Two',
  );
});

test('select modes match the draft matrix contract', () => {
  const rows = [
    { index: '1', id: '1', slug: 'hold', title: 'One' },
    { index: '2', id: '2', slug: 'breaking-news', title: 'Two' },
    { index: '3', id: '3', slug: 'hold', title: 'Three' },
  ];
  assert.equal(selectRecords(rows, { mode: 'first' })[0].title, 'One');
  assert.equal(selectRecords(rows, { mode: 'last' })[0].title, 'Three');
  assert.equal(selectRecords(rows, { mode: 'index', index: 2 })[0].title, 'Two');
  assert.equal(selectRecords(rows, { mode: 'byKey', key: 'id', value: '2' })[0].title, 'Two');
  assert.equal(selectRecords(rows, { mode: 'match', key: 'slug', pattern: '^breaking-' })[0].title, 'Two');
  assert.equal(selectRecords(rows, { mode: 'all' }).length, 3);
});

test('transforms and path refs stay deterministic', () => {
  assert.equal(applyDataTransform('  alpha  ', { op: 'trim' }), 'alpha');
  assert.equal(applyDataTransform('alpha', { op: 'prefix', value: '>>' }), '>>alpha');
  assert.equal(applyDataTransform('alpha', { op: 'replace', pattern: 'a', replacement: 'A', flags: 'g' }), 'AlphA');
  assert.equal(resolveDataPath({ type: 'literal', value: '/tmp/news.txt' }), '/tmp/news.txt');
  assert.equal(resolveDataPath({ type: 'variable', variableId: 'path' }, { path: '/tmp/x.json' }), '/tmp/x.json');
  assert.equal(extractAssetId('asset:11111111-1111-4111-8111-111111111111'), '11111111-1111-4111-8111-111111111111');
  assert.equal(extractAssetId('not-an-id'), null);
});

test('inline happy path writes typed overrides', async () => {
  const result = await runTemplateData({
    variables: [{ id: 'title', name: 'Title', type: 'text', defaultValue: '' }],
    data: {
      version: 1,
      sources: [{ id: 'src', type: 'inline', format: 'lines', content: 'Alpha\nBeta' }],
      pipelines: [{
        id: 'pipe',
        sourceId: 'src',
        select: { mode: 'first' },
        map: [{ from: 'line', to: { type: 'variable', variableId: 'title' }, as: 'text' }],
      }],
    },
  }, { trigger: 'take' });
  assert.equal(result.ok, true);
  assert.equal(result.overrides.title, 'Alpha');
});

test('invalid number follows onError keep and clear fixtures', async () => {
  const keep = await runTemplateData(loadDraft('data-error-keep.json'), { trigger: 'take' });
  assert.equal(keep.ok, false);
  assert.equal(keep.blocked, false);
  assert.deepEqual(keep.overrides, {});

  const clear = await runTemplateData(loadDraft('data-error-clear.json'), { trigger: 'take' });
  assert.equal(clear.ok, false);
  assert.equal(clear.overrides['error-number'], 0);
});

test('onError=block and onEmpty=block refuse TAKE', async () => {
  const blocked = await runTemplateData({
    variables: [{ id: 'title', name: 'Title', type: 'text', defaultValue: 'keep-me', drivenBy: 'pipe' }],
    data: {
      version: 1,
      onError: 'block',
      sources: [{ id: 'src', type: 'inline', format: 'lines', content: 'Alpha' }],
      pipelines: [{
        id: 'pipe',
        sourceId: 'missing',
        select: { mode: 'first' },
        map: [{ from: 'line', to: { type: 'variable', variableId: 'title' } }],
      }],
    },
  }, { trigger: 'take' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocked, true);
  assert.deepEqual(blocked.overrides, {});

  const empty = await runTemplateData({
    variables: [{ id: 'title', name: 'Title', type: 'text', defaultValue: 'keep-me' }],
    data: {
      version: 1,
      onError: 'keep',
      sources: [{ id: 'src', type: 'inline', format: 'kv', content: 'id=1' }],
      pipelines: [{
        id: 'pipe',
        sourceId: 'src',
        select: { mode: 'byKey', key: 'id', value: 'missing-block' },
        onEmpty: 'block',
        map: [{ from: 'id', to: { type: 'variable', variableId: 'title' } }],
      }],
    },
  }, { trigger: 'take' });
  assert.equal(empty.ok, false);
  assert.equal(empty.blocked, true);
});

test('runOn skips pipelines that are not scheduled for the trigger', async () => {
  const result = await runTemplateData({
    data: {
      version: 1,
      runOn: ['update'],
      sources: [{ id: 'src', type: 'inline', format: 'lines', content: 'X' }],
      pipelines: [{
        id: 'pipe',
        sourceId: 'src',
        select: { mode: 'first' },
        map: [{ from: 'line', to: { type: 'variable', variableId: 'title' } }],
      }],
    },
  }, { trigger: 'take' });
  assert.deepEqual(result, { ok: true, overrides: {}, errors: [] });
});

test('injected file and media resolvers stay backend-owned', async () => {
  const files = { '/tmp/news.txt': 'Alpha\nBeta' };
  const result = await runTemplateData({
    variables: [{ id: 'title', name: 'Title', type: 'text', defaultValue: '' }],
    data: {
      version: 1,
      sources: [{
        id: 'src',
        type: 'textfile',
        format: 'lines',
        path: { type: 'literal', value: '/tmp/news.txt' },
      }],
      pipelines: [{
        id: 'pipe',
        sourceId: 'src',
        select: { mode: 'last' },
        map: [{ from: 'line', to: { type: 'variable', variableId: 'title' } }],
      }],
    },
  }, {
    trigger: 'take',
    readFile: async (path) => files[path],
  });
  assert.equal(result.overrides.title, 'Beta');
});

test('display-name media tokens are forbidden', async () => {
  const result = await runTemplateData({
    variables: [{ id: 'art', name: 'Art', type: 'image', defaultValue: '' }],
    data: {
      version: 1,
      sources: [{ id: 'src', type: 'inline', format: 'lines', content: 'hero.jpg' }],
      pipelines: [{
        id: 'pipe',
        sourceId: 'src',
        select: { mode: 'first' },
        map: [{ from: 'line', to: { type: 'variable', variableId: 'art' }, as: 'image' }],
        mediaResolve: { strategy: ['assetId'], onMiss: 'keep' },
      }],
    },
  }, { trigger: 'take', resolveMedia: async () => '/uploads/hero.jpg' });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.match(result.errors[0].message, /display-name/);
});

test('time maps keep the original expression string', async () => {
  const now = Date.parse('2026-08-23T12:00:00.000Z');
  const result = await runTemplateData({
    variables: [{ id: 'when', name: 'When', type: 'text', defaultValue: '' }],
    data: {
      version: 1,
      sources: [{ id: 'src', type: 'inline', format: 'lines', content: 'now+5m' }],
      pipelines: [{
        id: 'pipe',
        sourceId: 'src',
        select: { mode: 'first' },
        map: [{ from: 'line', to: { type: 'variable', variableId: 'when' }, as: 'time' }],
      }],
    },
  }, { trigger: 'take', nowMs: now });
  assert.equal(result.ok, true);
  assert.equal(result.overrides.when, 'now+5m');
});
