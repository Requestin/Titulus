import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

const ROOTS = ['engine', 'backend/src', 'frontend/src', 'runtime/src', 'shared'];
const FORBIDDEN = [
  'bg_vs_engine',
  'run-vs-channel',
  'render_backend=unreal',
  "render_backend: 'unreal'",
  'render_backend: "unreal"',
];

function ripgrep(needle) {
  try {
    return execFileSync('rg', ['-n', '--fixed-strings', needle, ...ROOTS], {
      encoding: 'utf8',
    });
  } catch (error) {
    if (error.status === 1) return '';
    throw error;
  }
}

test('product trees do not contain Unreal/VS engine paths', () => {
  for (const needle of FORBIDDEN) {
    const hits = ripgrep(needle);
    assert.equal(hits, '', `forbidden product hit for ${needle}:\n${hits}`);
  }
});
