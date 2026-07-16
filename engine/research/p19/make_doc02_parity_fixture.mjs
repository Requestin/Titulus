#!/usr/bin/env node
// Freeze canonical test1 at one timeline frame for deterministic off/on parity.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(
  path.dirname(path.dirname(url.fileURLToPath(import.meta.url))),
  '..', '..',
);
const input = process.argv[2]
  ?? path.join(root, 'tests/templates/test1.json');
const frame = Number(process.argv[3] ?? 0);
const output = process.argv[4];

if (!Number.isFinite(frame) || frame < 0 || !output) {
  console.error('usage: make_doc02_parity_fixture.mjs INPUT FRAME OUTPUT');
  process.exit(2);
}

if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
await import(url.pathToFileURL(
  path.join(root, 'backend/public/bg-runtime.js'),
).href);
const runtime = globalThis.window.BG ?? globalThis.BG;
const template = JSON.parse(fs.readFileSync(input, 'utf8'));
const sample = runtime.sampleAt(
  runtime.normalizeTimeline(template.timeline),
  frame,
);

const transformKeys = new Set([
  'x', 'y', 'width', 'height', 'rotation', 'rotationX', 'rotationY',
  'perspective', 'scaleX', 'scaleY', 'anchorX', 'anchorY',
]);
for (const layer of template.layers) {
  const values = sample.layers[layer.id] ?? {};
  for (const [key, value] of Object.entries(values)) {
    if (transformKeys.has(key)) layer.transform[key] = value;
    else if (key === 'opacity' || key === 'visible') layer[key] = value;
  }
  // Live content is intentionally hidden: this fixture verifies cached source
  // pixels plus transform/opacity/mask operators at an exact timeline sample.
  if (layer.type === 'clock' || layer.type === 'video') layer.visible = false;
}
for (const group of template.groups) {
  Object.assign(group.transform, sample.groups[group.id] ?? {});
}

template.timeline.keyframes = [];
template.timeline.actions = [];
for (const director of template.timeline.directors) director.autostart = false;
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(template));
console.log(`wrote ${output} at frame=${frame}`);
