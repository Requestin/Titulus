import assert from 'node:assert/strict';
import test from 'node:test';

import { parseStrictOptions } from '../lib/cli-options.mjs';

const schema = {
  allowed: new Set(['input', 'strict', 'min-fields']),
  boolean: new Set(['strict']),
};

test('strict option parser accepts explicit values and boolean flags', () => {
  assert.deepEqual(
    parseStrictOptions(['--input=x.csv', '--strict', '--min-fields', '100'], schema),
    { input: 'x.csv', strict: true, 'min-fields': '100' },
  );
});

test('strict option parser rejects unknown, duplicate, positional, and missing values', () => {
  assert.throws(() => parseStrictOptions(['--min-field=100'], schema), /unknown option/);
  assert.throws(() => parseStrictOptions(['--strict', '--strict'], schema), /duplicate option/);
  assert.throws(() => parseStrictOptions(['x.csv'], schema), /unexpected positional/);
  assert.throws(() => parseStrictOptions(['--input'], schema), /requires a value/);
});
