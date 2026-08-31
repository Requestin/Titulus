import assert from 'node:assert/strict';
import test from 'node:test';

import { foldersVisibleInControl, templatesVisibleInControl } from './visibleControlTemplates';

test('Control hides templates filed in hide_in_control folders', () => {
  const visible = templatesVisibleInControl(
    [
      { id: 'open', folder_id: 'news' },
      { id: 'secret', folder_id: 'hidden' },
      { id: 'loose', folder_id: null },
    ],
    [
      { id: 'news', hide_in_control: 0 },
      { id: 'hidden', hide_in_control: 1 },
    ],
  );
  assert.deepEqual(visible.map((item) => item.id), ['open', 'loose']);
});

test('hideAll returns empty list', () => {
  const visible = templatesVisibleInControl(
    [{ id: 'open', folder_id: 'news' }, { id: 'loose', folder_id: null }],
    [{ id: 'news', hide_in_control: 0 }],
    { hideAll: true },
  );
  assert.deepEqual(visible, []);
});

test('hideUnassigned excludes templates without folder_id', () => {
  const visible = templatesVisibleInControl(
    [
      { id: 'open', folder_id: 'news' },
      { id: 'loose', folder_id: null },
    ],
    [{ id: 'news', hide_in_control: 0 }],
    { hideUnassigned: true },
  );
  assert.deepEqual(visible.map((item) => item.id), ['open']);
});

test('foldersVisibleInControl excludes hide_in_control folders', () => {
  const visible = foldersVisibleInControl([
    { id: 'news', hide_in_control: 0 },
    { id: 'hidden', hide_in_control: 1 },
  ]);
  assert.deepEqual(visible.map((item) => item.id), ['news']);
});
