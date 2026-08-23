import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatNumber,
  nudgeAngle45,
  nudgeNumber,
  parseNumberDraft,
  roundForStep,
} from './numberInputMath';

test('number drafts parse complete finite decimal and exponent forms', () => {
  assert.equal(parseNumberDraft('0'), 0);
  assert.equal(parseNumberDraft('-12.5'), -12.5);
  assert.equal(parseNumberDraft(' 1.25e2 '), 125);
  assert.equal(parseNumberDraft('+0.125'), 0.125);
});

test('number drafts keep incomplete edits pending and reject garbage', () => {
  for (const draft of [
    '',
    ' ',
    '-',
    '+',
    '.',
    '-.',
    '+.',
    '12px',
    '1.2.3',
    'NaN',
    'Infinity',
    '-Infinity',
  ]) {
    assert.equal(parseNumberDraft(draft), null, draft);
  }
});

test('number formatting is stable for finite values and safe for non-finite values', () => {
  assert.equal(formatNumber(12.5), '12.5');
  assert.equal(formatNumber(0), '0');
  assert.equal(formatNumber(-0), '0');
  assert.equal(formatNumber(Number.NaN), '0');
  assert.equal(formatNumber(Number.POSITIVE_INFINITY), '0');
  assert.equal(formatNumber(Number.NEGATIVE_INFINITY), '0');
});

test('step rounding snaps to fractional increments without float noise', () => {
  assert.equal(roundForStep(1.13, 0.25), 1.25);
  assert.equal(roundForStep(1.12, 0.25), 1);
  assert.equal(roundForStep(0.30000000000000004, 0.1), 0.3);
  assert.equal(roundForStep(-1.26, 0.1), -1.3);
  assert.equal(roundForStep(17.6, 5), 20);
});

test('invalid steps leave a finite value unchanged', () => {
  assert.equal(roundForStep(1.25, 0), 1.25);
  assert.equal(roundForStep(1.25, -0.5), 1.25);
  assert.equal(roundForStep(1.25, Number.NaN), 1.25);
  assert.equal(roundForStep(1.25, Number.POSITIVE_INFINITY), 1.25);
});

test('nudge applies fractional steps and clamps to min and max', () => {
  const options = { step: 0.25, min: -1, max: 1 };

  assert.equal(nudgeNumber(0.5, 1, options), 0.75);
  assert.equal(nudgeNumber(0.5, -1, options), 0.25);
  assert.equal(nudgeNumber(0.9, 1, options), 1);
  assert.equal(nudgeNumber(-0.9, -1, options), -1);
});

test('Shift-style nudge multiplies the delta by ten and does not mutate options', () => {
  const options = { step: 0.1, min: -10, max: 10, shift: true };
  const before = { ...options };

  assert.equal(nudgeNumber(1.2, 1, options), 2.2);
  assert.equal(nudgeNumber(1.2, -1, options), 0.2);
  assert.deepEqual(options, before);
});

test('invalid number inputs do not escape nudge bounds', () => {
  const options = { step: 1, min: -5, max: 5 };

  assert.equal(nudgeNumber(Number.NaN, 1, options), 0);
  assert.equal(nudgeNumber(Number.POSITIVE_INFINITY, -1, options), 5);
  assert.equal(nudgeNumber(Number.NEGATIVE_INFINITY, 1, options), -5);
});

test('angle actions add or subtract 45 degrees without wrapping', () => {
  assert.equal(nudgeAngle45(0, 1), 45);
  assert.equal(nudgeAngle45(0, -1), -45);
  assert.equal(nudgeAngle45(350, 1), 395);
  assert.equal(nudgeAngle45(-350, -1), -395);
});
