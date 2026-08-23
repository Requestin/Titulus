export const id = '001_data_files';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS data_files (
      id            TEXT PRIMARY KEY,
      original_name TEXT NOT NULL,
      stored_name   TEXT NOT NULL UNIQUE,
      mime          TEXT NOT NULL,
      size_bytes    INTEGER NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
