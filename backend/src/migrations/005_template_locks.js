export const id = '005_template_locks';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS template_locks (
      template_id  TEXT PRIMARY KEY REFERENCES templates(id) ON DELETE CASCADE,
      user_id      TEXT NOT NULL,
      username     TEXT NOT NULL,
      token        TEXT NOT NULL,
      acquired_at  TEXT NOT NULL DEFAULT (datetime('now')),
      heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
