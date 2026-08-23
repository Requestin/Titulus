export const id = '003_template_folders';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS template_folders (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      hide_in_control INTEGER NOT NULL DEFAULT 0,
      sort_order      INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const cols = db.prepare('PRAGMA table_info(templates)').all();
  if (!cols.some((col) => col.name === 'folder_id')) {
    db.exec('ALTER TABLE templates ADD COLUMN folder_id TEXT REFERENCES template_folders(id) ON DELETE SET NULL');
  }
}
