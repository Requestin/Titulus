import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultTemplate, createDefaultTransform } from '@runtime';
import {
  clearGesturePreview,
  gesturePreviewStore,
  publishGesturePreview,
} from './gesturePreview';
import { useEditor } from './store';

test('gesture preview replaces live values without mutating the editor document', () => {
  const template = createDefaultTemplate();
  useEditor.getState().load(template);
  clearGesturePreview();

  const first = { ...createDefaultTransform(120, 80), x: 120, y: 80 };
  const second = { ...first, x: 360, y: 240 };
  publishGesturePreview({ id: 'layer-a', kind: 'layer', transform: first });
  publishGesturePreview({ id: 'layer-a', kind: 'layer', transform: second });

  assert.deepEqual(gesturePreviewStore.getState().preview, {
    id: 'layer-a',
    kind: 'layer',
    transform: second,
  });
  assert.equal(useEditor.getState().template, template);
  assert.equal(useEditor.getState().dirty, false);
});

test('clearing a gesture preview restores the inspector fallback state', () => {
  clearGesturePreview();
  publishGesturePreview({
    id: 'layer-a',
    kind: 'layer',
    transform: createDefaultTransform(120, 80),
  });

  clearGesturePreview();

  assert.equal(gesturePreviewStore.getState().preview, null);
});
