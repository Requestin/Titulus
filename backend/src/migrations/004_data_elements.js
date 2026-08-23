export const id = '004_data_elements';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS data_elements (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
      payload     TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS data_elements_template_idx ON data_elements(template_id);
  `);
}
