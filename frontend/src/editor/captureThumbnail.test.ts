import assert from 'node:assert/strict';
import test from 'node:test';

import { thumbnailLabel } from './captureThumbnail';

test('thumbnailLabel keeps short names and ellipsizes long ones', () => {
  assert.equal(thumbnailLabel('Lower Third'), 'Lower Third');
  assert.equal(thumbnailLabel('  x  '), 'x');
  assert.equal(thumbnailLabel('a'.repeat(50)).endsWith('…'), true);
  assert.equal(thumbnailLabel('a'.repeat(50)).length, 42);
});
