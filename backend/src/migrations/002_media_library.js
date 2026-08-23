export const id = '002_media_library';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_library_assets (
      id              TEXT PRIMARY KEY,
      media_asset_id  TEXT NOT NULL UNIQUE REFERENCES media_assets(id),
      title           TEXT NOT NULL,
      notes           TEXT NOT NULL DEFAULT '',
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS media_tags (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS media_library_asset_tags (
      asset_id TEXT NOT NULL REFERENCES media_library_assets(id) ON DELETE CASCADE,
      tag_id   TEXT NOT NULL REFERENCES media_tags(id) ON DELETE CASCADE,
      PRIMARY KEY (asset_id, tag_id)
    );
  `);
  db.exec(`
    INSERT OR IGNORE INTO media_library_assets (id, media_asset_id, title)
    SELECT id, id, original_name FROM media_assets WHERE status = 'ready';
  `);
}
