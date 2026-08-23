import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { prepareTemplate, rebaseCrawlTimeline } from '../src/prepareTemplate.js';
import { scheduleCrawl } from '../src/crawlSchedule.js';

const draftDir = new URL('../../tests/fixtures/p21/draft/', import.meta.url);

function loadDraft(name) {
  return JSON.parse(readFileSync(new URL(name, draftDir), 'utf8'));
}

test('inline data prepare writes overrides onto an immutable snapshot', async () => {
  const source = {
    name: 'Prep',
    canvas: { width: 1920, height: 1080, background: '#000' },
    variables: [{ id: 'title', name: 'Title', label: 'Title', type: 'text', defaultValue: 'old' }],
    groups: [],
    layers: [],
    rootStack: [],
    groupStacks: {},
    timeline: { fps: 50, durationFrames: 100, playbackMode: 'bounded', directors: [], trackDirectors: {}, keyframes: [], actions: [] },
    data: {
      version: 1,
      sources: [{ id: 'src', type: 'inline', format: 'lines', content: 'Alpha' }],
      pipelines: [{
        id: 'pipe',
        sourceId: 'src',
        select: { mode: 'first' },
        map: [{ from: 'line', to: { type: 'variable', variableId: 'title' } }],
      }],
    },
  };
  const result = await prepareTemplate(source, { trigger: 'take' });
  assert.equal(result.ok, true);
  assert.equal(result.overrides.title, 'Alpha');
  assert.equal(result.template.variables[0].defaultValue, 'Alpha');
  assert.equal(source.variables[0].defaultValue, 'old');
});

test('onError=block prepare refuses TAKE', async () => {
  const result = await prepareTemplate(loadDraft('data-error-keep.json'), { trigger: 'take' });
  // keep fixture is not block; use a block wrapper
  const blocked = await prepareTemplate({
    ...loadDraft('data-error-keep.json'),
    data: { ...loadDraft('data-error-keep.json').data, onError: 'block' },
  }, { trigger: 'take' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocked, true);
  assert.deepEqual(blocked.overrides, {});
  void result;
});

test('file-backed pipeline reads through the hardened files API', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'titulus-p21-prep-'));
  mkdirSync(join(dataDir, 'data-files'), { recursive: true });
  writeFileSync(join(dataDir, 'data-files', 'news.txt'), 'FileLine\n');
  const result = await prepareTemplate({
    name: 'File',
    canvas: { width: 1920, height: 1080, background: '#000' },
    variables: [{ id: 'title', name: 'Title', label: 'Title', type: 'text', defaultValue: '' }],
    groups: [],
    layers: [],
    rootStack: [],
    groupStacks: {},
    timeline: { fps: 50, durationFrames: 100, playbackMode: 'bounded', directors: [], trackDirectors: {}, keyframes: [], actions: [] },
    data: {
      version: 1,
      sources: [{
        id: 'src',
        type: 'textfile',
        format: 'lines',
        path: { type: 'literal', value: '/data-files/news.txt' },
      }],
      pipelines: [{
        id: 'pipe',
        sourceId: 'src',
        select: { mode: 'first' },
        map: [{ from: 'line', to: { type: 'variable', variableId: 'title' } }],
      }],
    },
  }, { trigger: 'take', dataDir, env: {} });
  assert.equal(result.ok, true);
  assert.equal(result.overrides.title, 'FileLine');
});

test('crawl duration rebases after dynamic text without rewriting fromEnd offsets', () => {
  const short = scheduleCrawl({
    content: 'Hi',
    fps: 50,
    box: { width: 760, height: 96 },
    fontSize: 48,
    align: 'left',
    crawl: {
      type: 'ticker',
      directionIn: 'right',
      directionOut: 'left',
      speed: 5,
      pause: 0,
      separatorMode: 'none',
      separatorText: '',
      animationType: 'batch',
      maxTextLengthEnabled: false,
      maxTextLength: 80,
    },
  });
  const long = scheduleCrawl({
    ...{
      content: 'A much longer crawl line for duration',
      fps: 50,
      box: { width: 760, height: 96 },
      fontSize: 48,
      align: 'left',
      crawl: {
        type: 'ticker',
        directionIn: 'right',
        directionOut: 'left',
        speed: 5,
        pause: 0,
        separatorMode: 'none',
        separatorText: '',
        animationType: 'batch',
        maxTextLengthEnabled: false,
        maxTextLength: 80,
      },
    },
  });
  assert.ok(long.durationFrames > short.durationFrames);

  const template = {
    variables: [{ id: 'crawl-text', name: 'Crawl', label: 'Crawl', type: 'text', defaultValue: 'A much longer crawl line for duration' }],
    layers: [{
      id: 'crawl-1',
      type: 'crawl',
      content: { type: 'variable', variableId: 'crawl-text' },
      style: { fontSize: 48, align: 'left' },
      transform: { width: 760, height: 96 },
      crawlDirectorId: 'dir-crawl',
      crawl: {
        type: 'ticker',
        directionIn: 'right',
        directionOut: 'left',
        speed: 5,
        pause: 0,
        separatorMode: 'none',
        separatorText: '',
        animationType: 'batch',
        maxTextLengthEnabled: false,
        maxTextLength: 80,
      },
    }],
    timeline: {
      fps: 50,
      durationFrames: 250,
      directors: [{ id: 'dir-crawl', name: 'Crawl', durationFrames: short.durationFrames, offsetFrames: 0, autostart: true, loop: false, swing: false }],
      keyframes: [
        { id: 'k0', frame: 0, layers: { 'crawl-1': { crawlProgress: 0 } }, groups: {}, easing: 'linear' },
        { id: 'k1', frame: short.durationFrames, layers: { 'crawl-1': { crawlProgress: 1 } }, groups: {}, easing: 'linear' },
      ],
      cues: [{ id: 'cue-end', directorId: 'dir-crawl', frame: 10, fromEnd: true, name: 'End', items: [{ id: 'i', command: 'tag', parameterTag: 'End scene', lengthFrames: 0, direction: 'normal' }] }],
    },
  };
  rebaseCrawlTimeline(template);
  assert.equal(template.timeline.directors[0].durationFrames, long.durationFrames);
  assert.equal(template.timeline.cues[0].frame, 10);
  assert.equal(template.timeline.keyframes[1].frame, long.durationFrames);
});
