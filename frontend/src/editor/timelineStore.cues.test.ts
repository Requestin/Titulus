import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultTemplate } from '@runtime';
import { useEditor } from './store';
import { playheadStore, requestContinue } from './playheadStore';

function loadCueTemplate() {
  const template = createDefaultTemplate();
  template.timeline.directors[0]!.durationFrames = 150;
  template.timeline.directors.push({
    id: 'update',
    name: 'Update',
    durationFrames: 100,
    offsetFrames: 0,
    autostart: false,
    loop: false,
    swing: false,
  });
  template.timeline.cues = [];
  useEditor.getState().load(template);
  useEditor.getState().setActiveDirector('default');
  useEditor.getState().setPlayhead(10);
  return template;
}

test('selectedCueId stays out of zundo', () => {
  loadCueTemplate();
  const before = useEditor.temporal.getState().pastStates.length;
  useEditor.getState().selectCue('missing');
  assert.equal(useEditor.getState().selectedCueId, 'missing');
  assert.equal(useEditor.temporal.getState().pastStates.length, before);
});

test('addCueAtPlayhead merges items on the same effective frame', () => {
  loadCueTemplate();
  const before = useEditor.temporal.getState().pastStates.length;
  useEditor.getState().addCueAtPlayhead();
  useEditor.getState().addCueAtPlayhead();
  const cues = useEditor.getState().template!.timeline.cues ?? [];
  assert.equal(cues.length, 1);
  assert.equal(cues[0]!.items.length, 2);
  assert.equal(cues[0]!.frame, 10);
  assert.equal(useEditor.temporal.getState().pastStates.length, before + 2);
});

test('moveCue onto another cue merges items and deletes the source', () => {
  loadCueTemplate();
  useEditor.getState().addCueAtPlayhead();
  useEditor.getState().setPlayhead(40);
  useEditor.getState().addCueAtPlayhead();
  const [first, second] = useEditor.getState().template!.timeline.cues ?? [];
  useEditor.getState().moveCue(second!.id, 10);
  const cues = useEditor.getState().template!.timeline.cues ?? [];
  assert.equal(cues.length, 1);
  assert.equal(cues[0]!.id, first!.id);
  assert.equal(cues[0]!.items.length, 2);
  assert.equal(useEditor.getState().selectedCueId, first!.id);
});

test('protected Update director cannot be renamed or removed, and removeDirector strips cues', () => {
  loadCueTemplate();
  useEditor.getState().setActiveDirector('default');
  useEditor.getState().addCueAtPlayhead();
  useEditor.getState().updateDirector('update', { name: 'Nope' });
  assert.equal(
    useEditor.getState().template!.timeline.directors.find((item) => item.id === 'update')?.name,
    'Update',
  );
  useEditor.getState().removeDirector('update');
  assert.ok(useEditor.getState().template!.timeline.directors.some((item) => item.id === 'update'));

  useEditor.getState().setActiveDirector('default');
  const extra = useEditor.getState().template!.timeline.directors.find((item) => item.id === 'default');
  assert.ok(extra);
  useEditor.getState().addDirector();
  const added = useEditor.getState().activeDirectorId;
  useEditor.getState().addCueAtPlayhead();
  useEditor.getState().removeDirector(added);
  assert.equal(
    (useEditor.getState().template!.timeline.cues ?? []).some((cue) => cue.directorId === added),
    false,
  );
});

test('requestContinue is a transient playhead token', () => {
  const before = playheadStore.getState().continueRequestId;
  requestContinue();
  assert.equal(playheadStore.getState().continueRequestId, before + 1);
});
