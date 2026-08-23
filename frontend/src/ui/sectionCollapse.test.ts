import assert from 'node:assert/strict';
import test from 'node:test';
import {
  toggleSectionCollapseSignal,
  type SectionCollapseSignal,
} from './sectionCollapse';

test('section collapse signal toggles open and increments version', () => {
  const current: SectionCollapseSignal = { version: 0, open: true };

  assert.deepEqual(toggleSectionCollapseSignal(current), {
    version: 1,
    open: false,
  });
});

test('successive section collapse signals alternate open state', () => {
  const initial: SectionCollapseSignal = { version: 7, open: false };
  const expanded = toggleSectionCollapseSignal(initial);
  const collapsed = toggleSectionCollapseSignal(expanded);

  assert.deepEqual(expanded, { version: 8, open: true });
  assert.deepEqual(collapsed, { version: 9, open: false });
});

test('toggling creates a new signal without mutating the previous signal', () => {
  const current: SectionCollapseSignal = { version: 41, open: true };
  const before = { ...current };

  const next = toggleSectionCollapseSignal(current);

  assert.notEqual(next, current);
  assert.deepEqual(current, before);
  assert.deepEqual(next, { version: 42, open: false });
});
