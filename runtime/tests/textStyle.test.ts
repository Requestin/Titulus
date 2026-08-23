import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTextTransform, textShadowCss } from '../src/textStyle.js';

test('applyTextTransform keeps stored text for none and missing mode', () => {
  assert.equal(applyTextTransform('Ёлка Hello'), 'Ёлка Hello');
  assert.equal(applyTextTransform('Ёлка Hello', 'none'), 'Ёлка Hello');
});

test('applyTextTransform covers uppercase lowercase and titlecase', () => {
  assert.equal(applyTextTransform('ёлка hello', 'uppercase'), 'ЁЛКА HELLO');
  assert.equal(applyTextTransform('ЁЛКА HELLO', 'lowercase'), 'ёлка hello');
  assert.equal(applyTextTransform('ёлка hello', 'titlecase'), 'Ёлка Hello');
});

test('textShadowCss uses offsets and falls back to legacy distance', () => {
  const base = { dropShadow: true, dropShadowBlur: 6, dropShadowColor: '#000', dropShadowDistance: 2 };
  assert.equal(textShadowCss({ ...base, dropShadow: false }), '');
  assert.equal(textShadowCss(base), '0px 2px 6px #000');
  assert.equal(textShadowCss({ ...base, dropShadowOffsetX: 4, dropShadowOffsetY: 6 }), '4px 6px 6px #000');
});
