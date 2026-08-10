import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const devStart = new URL('../dev-start.sh', import.meta.url);

test('dev-start port guard preserves a detected busy port through awk END', () => {
  const source = readFileSync(devStart, 'utf8');

  assert.match(source, /\$4 ~ \(":" port "\$"\) \{ found = 1 \}/);
  assert.match(source, /END \{ exit found \? 0 : 1 \}/);
  assert.doesNotMatch(source, /\$4 ~ p \{exit 0\} END \{exit 1\}/);
});
