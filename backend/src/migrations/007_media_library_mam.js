export const id = '007_media_library_mam';

export function up(db) {
  const cols = db.prepare(`PRAGMA table_info(media_library_assets)`).all().map((row) => row.name);
  if (!cols.includes('locked')) {
    db.exec(`ALTER TABLE media_library_assets ADD COLUMN locked INTEGER NOT NULL DEFAULT 0`);
  }
}
