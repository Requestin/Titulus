// runtime/test/data-pipeline-smoke-entry.ts
import assert from 'node:assert/strict';
import {
  parseLines,
  parseDelimited,
  parseKv,
  selectRecords,
  applyDataTransform,
  extractAssetId,
  runTemplateData,
} from '../src/dataPipeline.js';
import type { Template } from '../src/schema.js';

const lines = parseLines('a\n#c\n\nb\n', { commentPrefix: '#', skipEmpty: true });
assert.equal(lines.length, 2);
assert.equal(lines[0]!.line, 'a');
assert.equal(lines[1]!.index, '2');

const delim = parseDelimited(
  'n|t|p\nИванов|Корр|asset:8f3a2c1e-1111-4111-8111-444444444444\n',
  { delimiter: '|', hasHeader: true },
);
assert.equal(delim.length, 1);
assert.equal(delim[0]!.n, 'Иванов');
assert.ok(delim[0]!.p.startsWith('asset:'));

const kv = parseKv('name=Host\ntitle=Anchor\n');
assert.equal(kv[0]!.name, 'Host');

assert.equal(selectRecords(delim, { mode: 'first' })[0]!.n, 'Иванов');
assert.equal(selectRecords(delim, { mode: 'byKey', key: 'n', value: 'Иванов' }).length, 1);
assert.equal(applyDataTransform(' x ', { op: 'trim' }), 'x');
assert.equal(
  extractAssetId('asset:8f3a2c1e-1111-4111-8111-444444444444'),
  '8f3a2c1e-1111-4111-8111-444444444444',
);

const template = {
  id: 't',
  name: 't',
  canvas: { width: 1920, height: 1080, background: 'transparent' },
  groups: [],
  layers: [],
  rootStack: [],
  groupStacks: {},
  timeline: {
    fps: 50,
    durationFrames: 1,
    playbackMode: 'bounded',
    directors: [],
    trackDirectors: {},
    keyframes: [],
    actions: [],
  },
  variables: [
    {
      id: 'vName',
      name: 'name',
      label: 'Name',
      type: 'text',
      defaultValue: '',
      drivenBy: 'main',
      exposed: false,
    },
    {
      id: 'vFile',
      name: 'file',
      label: 'File',
      type: 'textfile',
      defaultValue: '/uploads/x.txt',
      exposed: true,
    },
  ],
  data: {
    version: 1 as const,
    runOn: ['take' as const],
    onError: 'block' as const,
    sources: [
      {
        id: 'src',
        type: 'inline' as const,
        format: 'delimited' as const,
        content: 'A|B\nИванов|Корр\n',
        options: { delimiter: '|', hasHeader: true },
      },
    ],
    pipelines: [
      {
        id: 'main',
        sourceId: 'src',
        select: { mode: 'first' as const },
        map: [{ from: 'A', to: { type: 'variable' as const, variableId: 'vName' }, as: 'text' as const }],
      },
    ],
  },
} satisfies Pick<Template, 'variables' | 'data'> & Template;

const result = await runTemplateData(template, {
  trigger: 'take',
  variables: { vName: '', vFile: '/uploads/x.txt' },
  readFile: async () => {
    throw new Error('should use inline');
  },
});
assert.equal(result.ok, true);
assert.equal(result.overrides.vName, 'Иванов');

console.log('data-pipeline-smoke: OK');
