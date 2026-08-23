import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  listFileRoots,
  readAllowedText,
  resolveReadableFile,
  writeManagedDataFile,
} from '../src/filesAccess.js';

function tempData() {
  return mkdtempSync(join(tmpdir(), 'titulus-p21-files-'));
}

test('TITULUS_FILE_ROOTS defaults to empty and only data-files is managed', () => {
  const dataDir = '/tmp/titulus-data';
  assert.deepEqual(listFileRoots({ dataDir, env: {} }), [join(dataDir, 'data-files')]);
  assert.deepEqual(
    listFileRoots({ dataDir, env: { TITULUS_FILE_ROOTS: '/srv/news:/mnt/samba' } }),
    [join(dataDir, 'data-files'), '/srv/news', '/mnt/samba'],
  );
});

test('managed upload and read stay inside data-files', () => {
  const dataDir = tempData();
  const stored = writeManagedDataFile(Buffer.from('Alpha\nBeta\n'), 'news.txt', { dataDir });
  const read = readAllowedText(stored.path, { dataDir, env: {} });
  assert.equal(read.text, 'Alpha\nBeta\n');
  assert.deepEqual(read.lines, ['Alpha', 'Beta', '']);
  assert.ok(!read.text.includes('/tmp'));
});

test('traversal, symlink and binary reads fail without leaking roots', () => {
  const dataDir = tempData();
  const extra = mkdtempSync(join(tmpdir(), 'titulus-extra-'));
  writeFileSync(join(dataDir, 'secret.db'), 'nope');
  writeFileSync(join(extra, 'ok.txt'), 'ok');
  mkdirSync(join(dataDir, 'data-files'), { recursive: true });
  symlinkSync(join(dataDir, 'secret.db'), join(dataDir, 'data-files', 'escape.txt'));
  writeFileSync(join(dataDir, 'data-files', 'bin.txt'), Buffer.from([0x00, 0x01, 0x02]));

  const env = { TITULUS_FILE_ROOTS: extra };

  try {
    resolveReadableFile('/etc/passwd', { dataDir, env: {} });
    assert.fail('expected /etc/passwd to be rejected');
  } catch (error) {
    assert.equal(error.status, 403);
    assert.equal(error.code, 'PATH_NOT_ALLOWED');
    assert.doesNotMatch(error.message, /\/etc|data-files|TITULUS/);
    assert.equal(error.roots, undefined);
  }

  assert.throws(() => resolveReadableFile('/data-files/../secret.db', { dataDir, env: {} }), (error) => (
    error.status === 403 && !/secret\.db/.test(error.message)
  ));
  assert.throws(() => resolveReadableFile('/data-files/escape.txt', { dataDir, env: {} }), (error) => (
    error.status === 403 && !/secret\.db/.test(error.message)
  ));
  assert.throws(() => readAllowedText('/data-files/bin.txt', { dataDir, env: {} }), (error) => (
    error.status === 415
  ));

  const allowed = readAllowedText(join(extra, 'ok.txt'), { dataDir, env });
  assert.equal(allowed.text, 'ok');
});

test('oversize files are rejected', () => {
  const dataDir = tempData();
  assert.throws(
    () => writeManagedDataFile(Buffer.alloc(2 * 1024 * 1024 + 1), 'big.txt', { dataDir }),
    (error) => error.status === 413,
  );
});
