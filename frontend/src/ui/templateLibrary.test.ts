import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nextTemplateName,
  sortTemplates,
  type TemplateLibraryItem,
} from './templateLibrary';

function item(
  id: string,
  name: string,
  updated_at: string,
  created_at?: string,
): TemplateLibraryItem {
  return { id, name, updated_at, created_at };
}

const SAMPLE: TemplateLibraryItem[] = [
  item('b', 'bravo', '2026-08-20T12:00:00.000Z', '2026-08-10T12:00:00.000Z'),
  item('a', 'Alpha', '2026-08-22T09:00:00.000Z', '2026-08-21T09:00:00.000Z'),
  item('c', 'alpha', '2026-08-21T18:00:00.000Z', '2026-08-22T18:00:00.000Z'),
  item('d', 'Zulu', 'not-a-date', 'also-bad'),
];

test('sort by name is case-insensitive and does not mutate the source', () => {
  const source = SAMPLE.map((entry) => ({ ...entry }));
  const sorted = sortTemplates(source, 'name');

  assert.deepEqual(sorted.map((entry) => entry.id), ['a', 'c', 'b', 'd']);
  assert.deepEqual(source, SAMPLE.map((entry) => ({ ...entry })));
  assert.notEqual(sorted, source);
});

test('sort by name uses id as a deterministic tie-break', () => {
  const twins = [
    item('z', 'same', '2026-08-01T00:00:00.000Z'),
    item('m', 'same', '2026-08-02T00:00:00.000Z'),
    item('a', 'same', '2026-08-03T00:00:00.000Z'),
  ];

  assert.deepEqual(sortTemplates(twins, 'name').map((entry) => entry.id), ['a', 'm', 'z']);
});

test('sort by modified puts newest valid timestamps first and invalid dates last', () => {
  const sorted = sortTemplates(SAMPLE, 'modified');

  assert.deepEqual(sorted.map((entry) => entry.id), ['a', 'c', 'b', 'd']);
});

test('sort by modified uses name then id when timestamps match', () => {
  const twins = [
    item('z', 'Zulu', '2026-08-22T00:00:00.000Z'),
    item('b', 'alpha', '2026-08-22T00:00:00.000Z'),
    item('a', 'Alpha', '2026-08-22T00:00:00.000Z'),
  ];

  assert.deepEqual(sortTemplates(twins, 'modified').map((entry) => entry.id), ['a', 'b', 'z']);
});

test('sort by created puts newest created_at first', () => {
  const sorted = sortTemplates(SAMPLE, 'created');
  assert.deepEqual(sorted.map((entry) => entry.id), ['c', 'a', 'b', 'd']);
});

test('nextTemplateName trims and rejects empty or unchanged names', () => {
  assert.equal(nextTemplateName('Alpha', '  Bravo  '), 'Bravo');
  assert.equal(nextTemplateName('Alpha', 'Alpha'), null);
  assert.equal(nextTemplateName('Alpha', '  Alpha  '), null);
  assert.equal(nextTemplateName('Alpha', '   '), null);
  assert.equal(nextTemplateName('Alpha', ''), null);
});
