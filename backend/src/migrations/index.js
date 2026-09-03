import { id as dataFilesId, up as dataFilesUp } from './001_data_files.js';
import { id as mediaId, up as mediaUp } from './002_media_library.js';
import { id as foldersId, up as foldersUp } from './003_template_folders.js';
import { id as deId, up as deUp } from './004_data_elements.js';
import { id as locksId, up as locksUp } from './005_template_locks.js';
import { id as rbacId, up as rbacUp } from './006_rbac_groups.js';
import { id as mamId, up as mamUp } from './007_media_library_mam.js';
import { id as fontMamId, up as fontMamUp } from './008_font_mam.js';

export const MIGRATIONS = [
  { id: dataFilesId, up: dataFilesUp },
  { id: mediaId, up: mediaUp },
  { id: foldersId, up: foldersUp },
  { id: deId, up: deUp },
  { id: locksId, up: locksUp },
  { id: rbacId, up: rbacUp },
  { id: mamId, up: mamUp },
  { id: fontMamId, up: fontMamUp },
];
export function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const applied = new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map((row) => row.id),
  );
  const apply = db.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) continue;
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(migration.id);
    }
  });
  apply();
  return db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((row) => row.id);
}
