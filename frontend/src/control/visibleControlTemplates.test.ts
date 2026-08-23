import assert from 'node:assert/strict';
import test from 'node:test';

import { templatesVisibleInControl } from './visibleControlTemplates';

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
