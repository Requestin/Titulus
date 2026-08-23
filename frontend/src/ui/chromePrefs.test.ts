import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clamp,
  nextSize,
  readAllowedStringPreference,
  readBooleanPreference,
  readBoundedNumberPreference,
  type StorageLike,
  writeAllowedStringPreference,
  writeBooleanPreference,
  writeBoundedNumberPreference,
} from './chromePrefs';

function memoryStorage(initial: Record<string, string> = {}): StorageLike & {
  values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

const throwingStorage: StorageLike = {
  getItem() {
    throw new Error('storage read denied');
  },
  setItem() {
    throw new Error('storage write denied');
  },
};

test('boolean preferences accept only the canonical persisted values', () => {
  const storage = memoryStorage({
    enabled: '1',
    disabled: '0',
    garbage: 'true',
  });

  assert.equal(readBooleanPreference(storage, 'enabled', false), true);
  assert.equal(readBooleanPreference(storage, 'disabled', true), false);
  assert.equal(readBooleanPreference(storage, 'missing', true), true);
  assert.equal(readBooleanPreference(storage, 'garbage', false), false);
});

test('boolean preference reads and writes tolerate unavailable storage', () => {
  assert.equal(readBooleanPreference(throwingStorage, 'collapsed', true), true);
  assert.doesNotThrow(() => writeBooleanPreference(throwingStorage, 'collapsed', false));
});

test('boolean preferences persist as compact canonical values', () => {
  const storage = memoryStorage();

  writeBooleanPreference(storage, 'collapsed', true);
  assert.equal(storage.values.get('collapsed'), '1');
  writeBooleanPreference(storage, 'collapsed', false);
  assert.equal(storage.values.get('collapsed'), '0');
});

test('bounded number reads reject non-finite and partially numeric text', () => {
  const storage = memoryStorage({
    valid: '240.5',
    nan: 'NaN',
    infinity: 'Infinity',
    garbage: '240px',
    empty: '',
  });

  assert.equal(readBoundedNumberPreference(storage, 'valid', 300, 160, 640), 240.5);
  for (const key of ['nan', 'infinity', 'garbage', 'empty', 'missing']) {
    assert.equal(readBoundedNumberPreference(storage, key, 300, 160, 640), 300, key);
  }
  assert.equal(readBoundedNumberPreference(throwingStorage, 'width', 300, 160, 640), 300);
});

test('bounded number preferences clamp reads and writes', () => {
  const storage = memoryStorage({ low: '-20', high: '900' });

  assert.equal(readBoundedNumberPreference(storage, 'low', 300, 160, 640), 160);
  assert.equal(readBoundedNumberPreference(storage, 'high', 300, 160, 640), 640);

  writeBoundedNumberPreference(storage, 'width', 700, 160, 640);
  assert.equal(storage.values.get('width'), '640');
  writeBoundedNumberPreference(storage, 'width', 159.5, 160, 640);
  assert.equal(storage.values.get('width'), '160');
  assert.doesNotThrow(() =>
    writeBoundedNumberPreference(throwingStorage, 'width', 320, 160, 640),
  );
});

test('bounded number writes ignore NaN and infinities without changing storage', () => {
  const storage = memoryStorage({ width: '320' });

  writeBoundedNumberPreference(storage, 'width', Number.NaN, 160, 640);
  writeBoundedNumberPreference(storage, 'width', Number.POSITIVE_INFINITY, 160, 640);
  writeBoundedNumberPreference(storage, 'width', Number.NEGATIVE_INFINITY, 160, 640);

  assert.equal(storage.values.get('width'), '320');
});

test('clamp and nextSize apply panel bounds without mutating their inputs', () => {
  assert.equal(clamp(240, 160, 640), 240);
  assert.equal(clamp(-10, 160, 640), 160);
  assert.equal(clamp(900, 160, 640), 640);

  const bounds = { min: 160, max: 640 };
  const before = { ...bounds };
  assert.equal(nextSize(300, 25, bounds), 325);
  assert.equal(nextSize(630, 25, bounds), 640);
  assert.equal(nextSize(170, -25, bounds), 160);
  assert.deepEqual(bounds, before);
});

const SORT_BY = ['modified', 'name'] as const;

test('allowed string preferences accept only allowlisted values', () => {
  const storage = memoryStorage({
    sort: 'name',
    garbage: 'created',
    empty: '',
  });

  assert.equal(readAllowedStringPreference(storage, 'sort', SORT_BY, 'modified'), 'name');
  assert.equal(readAllowedStringPreference(storage, 'garbage', SORT_BY, 'modified'), 'modified');
  assert.equal(readAllowedStringPreference(storage, 'empty', SORT_BY, 'modified'), 'modified');
  assert.equal(readAllowedStringPreference(storage, 'missing', SORT_BY, 'modified'), 'modified');
});

test('allowed string preference reads and writes tolerate unavailable storage', () => {
  assert.equal(
    readAllowedStringPreference(throwingStorage, 'sort', SORT_BY, 'modified'),
    'modified',
  );
  assert.doesNotThrow(() =>
    writeAllowedStringPreference(throwingStorage, 'sort', SORT_BY, 'name'),
  );
});

test('allowed string writes persist allowlisted values and ignore others', () => {
  const storage = memoryStorage({ sort: 'modified' });

  writeAllowedStringPreference(storage, 'sort', SORT_BY, 'name');
  assert.equal(storage.values.get('sort'), 'name');

  writeAllowedStringPreference(storage, 'sort', SORT_BY, 'created' as 'name');
  assert.equal(storage.values.get('sort'), 'name');
});
