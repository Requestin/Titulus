import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTimeExpression } from '../../shared/timeExpressions.mjs';
import { resolveClockAnchor } from '../src/clockBind.js';

const now = Date.parse('2026-08-23T12:00:00.000Z');

test('parseTimeExpression understands today@ now± and epoch', () => {
  const today = parseTimeExpression('today@18:00', now)!;
  const d = new Date(today);
  assert.equal(d.getHours(), 18);
  assert.equal(d.getMinutes(), 0);
  assert.equal(parseTimeExpression('now+5m', now), now + 5 * 60 * 1000);
  assert.equal(parseTimeExpression('1750000000000', now), 1750000000000);
  assert.equal(parseTimeExpression('nope', now), undefined);
});

test('resolveClockAnchor reads a bound time variable', () => {
  assert.equal(resolveClockAnchor(1000, {}, now), 1000);
  assert.equal(
    resolveClockAnchor({ type: 'variable', variableId: 'start' }, { start: 'now+5m' }, now),
    now + 5 * 60 * 1000,
  );
  assert.equal(resolveClockAnchor({ type: 'variable', variableId: 'missing' }, {}, now), undefined);
});
