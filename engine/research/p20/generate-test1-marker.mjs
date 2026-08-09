#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const markerStates = 64;
const markerX = 144;
const markerStep = 24;

function transform(x, y, width, height) {
  return {
    x, y, width, height,
    rotation: 0,
    rotationX: 0,
    rotationY: 0,
    perspective: 1000,
    scaleX: 1,
    scaleY: 1,
    anchorX: 0,
    anchorY: 0,
  };
}

function common(id, name, type, x, y, width, height, groupId = null) {
  return {
    id, name, type,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    groupId,
    transform: transform(x, y, width, height),
  };
}

function imageData(name, mime) {
  const bytes = readFileSync(new URL(`../../../tests/files/${name}`, import.meta.url));
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

const textStyle = {
  fontFamily: 'Inter',
  fontSize: 48,
  fontWeight: '600',
  fill: '#ffffff',
  align: 'left',
  lineHeight: 1.1,
  letterSpacing: 0,
  strokeColor: '#000000',
  strokeWidth: 0,
  dropShadow: false,
  dropShadowBlur: 6,
  dropShadowColor: '#000000',
  dropShadowDistance: 2,
};

export function generateP20Test1MarkerTemplate() {
  const groupA = 'p20-test1-group-a';
  const groupB = 'p20-test1-group-b';
  const groupC = 'p20-test1-group-c';
  const markerKeyframes = Array.from({ length: markerStates + 1 }, (_, frame) => ({
    id: `p20-test1-semantic-${String(frame).padStart(2, '0')}`,
    frame,
    layers: {
      'p20-test1-semantic-bar': { x: markerX + (frame % markerStates) * markerStep },
    },
    groups: {},
    easing: 'linear',
  }));
  const complexKeyframes = [
    [0, 0, 1100, 14, 984, 566, 0, 0],
    [50, 400, 1100, 300, 984, 566, 20, 0],
    [100, 1600, 1950, 13, -10, 0, 90, 69],
    [150, 900, 1500, 300, 500, 280, 45, 35],
    [200, 0, 1100, 13, 984, 566, 0, 0],
  ].map(([frame, clockX, imageX, image3X, maskY, maskWidth, groupARotation, groupCRotation]) => ({
    id: `p20-test1-complex-${frame}`,
    frame,
    layers: {
      'p20-test1-clock': { x: clockX },
      'p20-test1-image-2': { x: imageX },
      'p20-test1-image-3': { x: image3X },
      'p20-test1-bottom-mask': { y: maskY },
      'p20-test1-image-mask': { width: maskWidth },
    },
    groups: {
      [groupA]: { rotation: groupARotation, x: frame === 100 ? 1200 : 0 },
      [groupC]: { rotation: groupCRotation },
    },
    easing: 'power2.out',
  }));

  const layers = [
    {
      ...common('p20-test1-panel-a', 'Rectangle 1', 'rect', 52, 107, 325, 140, groupA),
      fill: '#1f2937', cornerRadius: 8, borderColor: '#000000', borderWidth: 0,
    },
    {
      ...common('p20-test1-text-a', 'Text 1', 'text', 100, 120, 237, 96, groupA),
      content: 'TEST 1', style: textStyle,
    },
    {
      ...common('p20-test1-image-1', 'Image 1', 'image', 1295, 34, 554, 624, groupB),
      src: imageData('1.jpg', 'image/jpeg'), cornerRadius: 0, fit: 'contain',
    },
    {
      ...common('p20-test1-image-mask', 'Mask 1', 'mask', 1290, 17, 566, 680, groupB),
      maskMode: 'normal', shape: 'rect', fill: '#000000',
      cornerRadius: 0, borderColor: '#000000', borderWidth: 0,
    },
    {
      ...common('p20-test1-clock', 'Clock 1', 'clock', 0, 688, 300, 96),
      mode: 'clock', format: 'HH:mm:ss',
      style: { ...textStyle, fill: '#ff4242', align: 'center' },
    },
    {
      ...common('p20-test1-image-2', 'Image 2', 'image', 1100, 774, 809, 290),
      src: imageData('2.png', 'image/png'), cornerRadius: 0, fit: 'cover',
    },
    {
      ...common('p20-test1-image-3', 'Image 3', 'image', 13, 422, 382, 270),
      src: imageData('3.jpg', 'image/jpeg'), cornerRadius: 0, fit: 'contain',
    },
    {
      ...common('p20-test1-panel-c', 'Rectangle 2', 'rect', 120, 120, 480, 140, groupC),
      fill: '#1f2937', cornerRadius: 32, borderColor: '#ff4242', borderWidth: 8,
    },
    {
      ...common('p20-test1-text-c', 'Text 2', 'text', 238, 135, 264, 96, groupC),
      content: 'TEXT 1', style: textStyle,
    },
    {
      ...common('p20-test1-bottom-mask', 'Mask 2', 'mask', -38, 984, 2015, 112),
      maskMode: 'inverted', shape: 'rect', fill: '#000000',
      cornerRadius: 0, borderColor: '#000000', borderWidth: 0,
    },
    {
      ...common('p20-test1-marker-track', 'Semantic track', 'rect', markerX, 180, 1536, 720),
      fill: '#202c34', cornerRadius: 0, borderColor: '#000000', borderWidth: 0,
      opacity: 0.35,
    },
    {
      ...common('p20-test1-semantic-bar', 'Semantic residue bar', 'rect', markerX, 180, 18, 720),
      fill: '#00ff7f', cornerRadius: 0, borderColor: '#000000', borderWidth: 0,
    },
  ];
  const complexTrackIds = layers
    .map((layer) => layer.groupId ?? layer.id)
    .filter((id) => !['p20-test1-marker-track', 'p20-test1-semantic-bar'].includes(id));

  return {
    schemaVersion: '1.0.0',
    id: '2c286517-b9b0-4b44-a335-7a12405c20a1',
    name: 'p20-test1-marker',
    description: 'Complex test1 motion plus independently decodable P20 field marker.',
    tags: ['p20', 'test1', 'semantic-marker', 'microfreeze'],
    metadata: {
      category: 'p20-test1-marker-v1',
      notes: 'Visual acceptance uses clock and complex motion; loopback decodes the green marker.',
    },
    canvas: { width: 1920, height: 1080, background: 'transparent' },
    variables: [],
    groups: [
      { id: groupA, name: 'Group 1', parentId: null, visible: true, locked: false, transform: transform(0, 0, 300, 80) },
      { id: groupB, name: 'Group 2', parentId: null, visible: true, locked: false, transform: transform(0, 0, 300, 80) },
      { id: groupC, name: 'Group 3', parentId: null, visible: true, locked: false, transform: transform(0, 764, 300, 80) },
    ],
    layers,
    rootStack: [
      { kind: 'group', id: groupA },
      { kind: 'group', id: groupB },
      { kind: 'layer', id: 'p20-test1-clock' },
      { kind: 'layer', id: 'p20-test1-image-2' },
      { kind: 'layer', id: 'p20-test1-image-3' },
      { kind: 'group', id: groupC },
      { kind: 'layer', id: 'p20-test1-bottom-mask' },
      { kind: 'layer', id: 'p20-test1-marker-track' },
      { kind: 'layer', id: 'p20-test1-semantic-bar' },
    ],
    groupStacks: {
      [groupA]: [
        { kind: 'layer', id: 'p20-test1-panel-a' },
        { kind: 'layer', id: 'p20-test1-text-a' },
      ],
      [groupB]: [
        { kind: 'layer', id: 'p20-test1-image-1' },
        { kind: 'layer', id: 'p20-test1-image-mask' },
      ],
      [groupC]: [
        { kind: 'layer', id: 'p20-test1-panel-c' },
        { kind: 'layer', id: 'p20-test1-text-c' },
      ],
    },
    timeline: {
      fps: 50,
      durationFrames: 200,
      playbackMode: 'infinite',
      directors: [
        { id: 'default', name: 'test1 motion', durationFrames: 200, offsetFrames: 0, autostart: true, loop: true, swing: false },
        { id: 'p20-semantic-director', name: 'P20 semantic residue', durationFrames: 64, offsetFrames: 0, autostart: true, loop: true, swing: false },
      ],
      trackDirectors: {
        ...Object.fromEntries([...new Set(complexTrackIds)].map((id) => [id, 'default'])),
        'p20-test1-semantic-bar': 'p20-semantic-director',
      },
      keyframes: [...complexKeyframes, ...markerKeyframes],
      actions: [],
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
    process.stdout.write('Usage: generate-test1-marker.mjs [--out=PATH] [--check]\n');
    return 0;
  }
  const rendered = `${JSON.stringify(generateP20Test1MarkerTemplate(), null, 2)}\n`;
  if (opts.check) {
    if (!opts.out) throw new Error('--check requires --out=PATH');
    if (readFileSync(opts.out, 'utf8') !== rendered) {
      throw new Error(`generated marker differs from ${opts.out}`);
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
    process.stderr.write(`[generate-test1-marker] ${error.message}\n`);
    process.exitCode = 1;
  }
}
