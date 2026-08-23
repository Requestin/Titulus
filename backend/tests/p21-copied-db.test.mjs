import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { runMigrations } from '../src/migrations/index.js';

const EXPECTED = [
  '001_data_files',
  '002_media_library',
  '003_template_folders',
  '004_data_elements',
  '005_template_locks',
  '006_rbac_groups',
];

const COPIED = process.env.TITULUS_P21_COPIED_DB
  || '/home/requestin/Titulus-evidence/p21-baseline-data/app.db';

test('copied P21.0 evidence DB migrates without losing channels', {
  skip: existsSync(COPIED) ? false : 'copied P21.0 app.db is not on this host',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'titulus-p21-copied-'));
  const path = join(dir, 'app.db');
  copyFileSync(COPIED, path);

  const db = openDb(path);
  assert.deepEqual(
    db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((row) => row.id),
    EXPECTED,
  );
  const channels = db.prepare('SELECT id FROM channels ORDER BY id').all().map((row) => row.id);
  assert.deepEqual(channels, ['p21-baseline-ch1', 'p21-baseline-ch2', 'p21-baseline-ch3']);
  assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='data_files'`).get());
  assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='media_library_assets'`).get());
  assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='template_folders'`).get());
  assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='data_elements'`).get());
  assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='template_locks'`).get());
  assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='permission_groups'`).get());
  const folderCol = db.prepare(`PRAGMA table_info(templates)`).all().some((col) => col.name === 'folder_id');
  assert.equal(folderCol, true);

  const again = runMigrations(db);
  assert.deepEqual(again, EXPECTED);
  db.close();

  const reopened = openDb(path);
  assert.deepEqual(
    reopened.prepare('SELECT id FROM channels ORDER BY id').all().map((row) => row.id),
    ['p21-baseline-ch1', 'p21-baseline-ch2', 'p21-baseline-ch3'],
  );
  reopened.close();
});
