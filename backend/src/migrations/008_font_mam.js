export const id = '008_font_mam';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS font_assets (
      id              TEXT PRIMARY KEY,
      family           TEXT NOT NULL,
      weight           TEXT NOT NULL DEFAULT 'normal',
      style            TEXT NOT NULL DEFAULT 'normal',
      file_path        TEXT NOT NULL,
      original_name    TEXT NOT NULL,
      title            TEXT NOT NULL DEFAULT '',
      locked           INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS font_assets_family_idx ON font_assets(family, weight, style);
  `);
}
