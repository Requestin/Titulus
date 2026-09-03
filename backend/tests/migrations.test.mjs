import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { runMigrations } from '../src/migrations/index.js';

test('openDb applies schema_migrations and data_files on a copied legacy DB', () => {
  const dir = mkdtempSync(join(tmpdir(), 'titulus-p21-mig-'));
  const path = join(dir, 'legacy.db');
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO templates (id, name, data) VALUES ('old', 'Old', '{}');
  `);
  legacy.close();

  const db = openDb(path);
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((row) => row.name);
  assert.ok(tables.includes('schema_migrations'));
  assert.ok(tables.includes('data_files'));
  assert.ok(tables.includes('templates'));
  assert.deepEqual(
    db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((row) => row.id),
    ['001_data_files', '002_media_library', '003_template_folders', '004_data_elements', '005_template_locks', '006_rbac_groups', '007_media_library_mam'],
  );
  assert.equal(db.prepare('SELECT name FROM templates WHERE id = ?').get('old').name, 'Old');

  const again = runMigrations(db);
  assert.deepEqual(again, ['001_data_files', '002_media_library', '003_template_folders', '004_data_elements', '005_template_locks', '006_rbac_groups', '007_media_library_mam']);
  db.close();
});

test('runMigrations is transactional and idempotent on a fresh memory db', () => {
  const db = openDb(':memory:');
  const first = runMigrations(db);
  const second = runMigrations(db);
  assert.deepEqual(first, second);
  assert.deepEqual(first, ['001_data_files', '002_media_library', '003_template_folders', '004_data_elements', '005_template_locks', '006_rbac_groups', '007_media_library_mam']);
  db.close();
});
