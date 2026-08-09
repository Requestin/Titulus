#!/usr/bin/env node
/**
 * Builds the P20 semantic-marker template. The bar's x coordinate is an
 * opaque, full-height code: `x = 144 + 24 * (semantic_id mod 64)`.
 *
 * Every field can therefore recover the residue from its own raster lines;
 * no OCR, alpha edge, or opposite-parity field is required. Capture analysis
 * joins consecutive residues into the monotonic semantic sequence.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIELD_STATES = 64;
const BAR_X = 144;
const BAR_STEP = 24;

const textStyle = {
  fontFamily: 'Arial',
  fontSize: 28,
  fontWeight: '700',
  fill: '#ffffff',
  align: 'left',
  lineHeight: 1,
  letterSpacing: 0,
  strokeColor: '#000000',
  strokeWidth: 2,
  dropShadow: false,
  dropShadowBlur: 0,
  dropShadowColor: '#000000',
  dropShadowDistance: 0,
};

function transform(x, y, width, height) {
  return {
    x,
    y,
    width,
    height,
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

function rect(id, name, x, y, width, height, fill) {
  return {
    id,
    name,
    type: 'rect',
    visible: true,
    locked: true,
    opacity: 1,
    blendMode: 'normal',
    transform: transform(x, y, width, height),
    groupId: null,
    fill,
    cornerRadius: 0,
    borderColor: '#000000',
    borderWidth: 0,
  };
}

function text(id, name, content, x, y, width, height) {
  return {
    id,
    name,
    type: 'text',
    visible: true,
    locked: true,
    opacity: 1,
    blendMode: 'normal',
    transform: transform(x, y, width, height),
    groupId: null,
    content,
    style: textStyle,
  };
}

function clock(id, name, x, y, width, height) {
  return {
    id,
    name,
    type: 'clock',
    visible: true,
    locked: true,
    opacity: 1,
    blendMode: 'normal',
    transform: transform(x, y, width, height),
    groupId: null,
    mode: 'clock',
    format: 'HH:mm:ss',
    style: {
      ...textStyle,
      fontSize: 48,
      align: 'right',
    },
  };
}

export function generateP20MovingBarTemplate() {
  const keyframes = Array.from({ length: FIELD_STATES + 1 }, (_, field) => ({
    id: `p20-semantic-frame-${String(field).padStart(2, '0')}`,
    frame: field,
    layers: {
      'p20-semantic-bar': {
        x: BAR_X + (field % FIELD_STATES) * BAR_STEP,
      },
    },
    groups: {},
    easing: 'linear',
  }));

  return {
    schemaVersion: '1.0.0',
    id: '2c286517-b9b0-4b44-a335-7a12405c2001',
    name: 'p20-moving-bar',
    description: 'P20 semantic marker v1: independently decodable full-height field residue.',
    tags: ['p20', 'semantic-marker', 'loopback', 'interlace'],
    metadata: {
      category: 'p20-semantic-marker-v1',
      safeTitle: 'P20 moving semantic bar',
      notes: 'Decode each field independently: residue = (bar_left_px - 144) / 24, '
        + 'range 0..63. The 720px opaque bar crosses both scanline parities; '
        + 'capture analysis reconstructs monotonic semantic IDs from consecutive residues.',
    },
    canvas: { width: 1920, height: 1080, background: '#000000' },
    variables: [],
    groups: [],
    layers: [
      rect('p20-marker-background', 'P20 marker contrast field', 120, 120, 1680, 840, '#101820'),
      rect('p20-marker-track', 'Semantic residue track', BAR_X, 180, BAR_STEP * FIELD_STATES, 720, '#202c34'),
      rect('p20-semantic-bar', 'Semantic residue bar', BAR_X, 180, 18, 720, '#00ff7f'),
      text('p20-marker-title', 'Marker title', 'P20 SEMANTIC MARKER v1', 144, 132, 850, 42),
      clock('p20-marker-clock', 'P20 operator clock', 1440, 126, 300, 54),
      text('p20-marker-decoder', 'Marker decoder', 'FIELD RESIDUE = (BAR X - 144) / 24  |  MOD 64', 144, 912, 1100, 34),
    ],
    rootStack: [
      { kind: 'layer', id: 'p20-marker-background' },
      { kind: 'layer', id: 'p20-marker-track' },
      { kind: 'layer', id: 'p20-semantic-bar' },
      { kind: 'layer', id: 'p20-marker-title' },
      { kind: 'layer', id: 'p20-marker-clock' },
      { kind: 'layer', id: 'p20-marker-decoder' },
    ],
    groupStacks: {},
    timeline: {
      fps: 50,
      durationFrames: FIELD_STATES,
      playbackMode: 'infinite',
      directors: [{
        id: 'p20-semantic-director',
        name: 'P20 semantic field residue',
        durationFrames: FIELD_STATES,
        offsetFrames: 0,
        autostart: true,
        loop: true,
        swing: false,
      }],
      trackDirectors: { 'p20-semantic-bar': 'p20-semantic-director' },
      keyframes,
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
    process.stdout.write('Usage: generate-semantic-marker.mjs [--out=PATH] [--check]\n');
    return 0;
  }
  const rendered = `${JSON.stringify(generateP20MovingBarTemplate(), null, 2)}\n`;
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
    process.stderr.write(`[generate-semantic-marker] ${error.message}\n`);
    process.exitCode = 1;
  }
}
