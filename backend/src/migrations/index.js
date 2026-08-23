import { id as dataFilesId, up as dataFilesUp } from './001_data_files.js';

export const MIGRATIONS = [
  { id: dataFilesId, up: dataFilesUp },
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
