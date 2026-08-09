#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { generateP20Test1MarkerTemplate } from './generate-test1-marker.mjs';

const markerLayerIds = new Set([
  'p20-test1-marker-track',
  'p20-test1-semantic-bar',
]);

export function generateP20Test1VisualTemplate() {
  const marker = generateP20Test1MarkerTemplate();
  const {
    'p20-test1-semantic-bar': _semanticBarDirector,
    ...trackDirectors
  } = marker.timeline.trackDirectors;

  return {
    ...marker,
    id: 'c8b6321a-e021-4fac-b0e1-425e593e3994',
    name: 'p20-test1-visual',
    description: 'Complex test1 motion without the P20 semantic marker overlay.',
    tags: ['p20', 'test1', 'microfreeze', 'visual'],
    metadata: {
      category: 'p20-test1-visual-v1',
      notes: 'Visual acceptance uses complex test1 motion without a semantic overlay.',
    },
    layers: marker.layers.filter((layer) => !markerLayerIds.has(layer.id)),
    rootStack: marker.rootStack.filter((entry) => !markerLayerIds.has(entry.id)),
    timeline: {
      ...marker.timeline,
      directors: marker.timeline.directors.filter(
        (director) => director.id !== 'p20-semantic-director',
      ),
      trackDirectors,
      keyframes: marker.timeline.keyframes.filter(
        (frame) => !frame.layers['p20-test1-semantic-bar'],
      ),
    },
  };
}

function options(argv) {
  const result = { out: null, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') result.check = true;
    else if (arg.startsWith('--out=')) result.out = arg.slice('--out='.length);
    else if (arg === '--out') result.out = argv[++index];
    else if (arg === '--help') result.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return result;
}

export function main(argv = process.argv.slice(2)) {
  const opts = options(argv);
  if (opts.help) {
    process.stdout.write('Usage: generate-test1-visual.mjs [--out=PATH] [--check]\n');
    return 0;
  }
  const rendered = `${JSON.stringify(generateP20Test1VisualTemplate(), null, 2)}\n`;
  if (opts.check) {
    if (!opts.out) throw new Error('--check requires --out=PATH');
    if (readFileSync(opts.out, 'utf8') !== rendered) {
      throw new Error(`generated visual template differs from ${opts.out}`);
    }
  } else if (opts.out) {
    writeFileSync(opts.out, rendered);
  } else {
    process.stdout.write(rendered);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`[generate-test1-visual] ${error.message}\n`);
    process.exitCode = 1;
  }
}
