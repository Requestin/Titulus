import { randomUUID } from 'node:crypto';

function rowToAsset(row, tags = []) {
  if (!row) return null;
  return {
    id: row.id,
    mediaAssetId: row.media_asset_id,
    title: row.title,
    notes: row.notes,
    type: row.type,
    status: row.status,
    url: row.playback_filename ? `/uploads/${row.playback_filename}` : null,
    posterUrl: row.poster_filename ? `/uploads/${row.poster_filename}` : null,
    originalName: row.original_name,
    token: `asset:${row.media_asset_id}`,
    tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mediaLibraryDao(db) {
  return {
    list({ q = '', tag = '' } = {}) {
      const rows = db.prepare(`
        SELECT l.*, a.type, a.status, a.original_name, a.playback_filename, a.poster_filename
        FROM media_library_assets l
        JOIN media_assets a ON a.id = l.media_asset_id
        WHERE (? = '' OR l.title LIKE ? OR a.original_name LIKE ?)
        ORDER BY l.updated_at DESC
      `).all(q, `%${q}%`, `%${q}%`);
      return rows
        .map((row) => rowToAsset(row, this.tagsFor(row.id)))
        .filter((asset) => !tag || asset.tags.includes(tag));
    },
    get(id) {
      const row = db.prepare(`
        SELECT l.*, a.type, a.status, a.original_name, a.playback_filename, a.poster_filename
        FROM media_library_assets l
        JOIN media_assets a ON a.id = l.media_asset_id
        WHERE l.id = ?
      `).get(id);
      return rowToAsset(row, this.tagsFor(id));
    },
    byMediaAsset(mediaAssetId) {
      const row = db.prepare('SELECT id FROM media_library_assets WHERE media_asset_id = ?').get(mediaAssetId);
      return row ? this.get(row.id) : null;
    },
    upsertFromJob(job) {
      const existing = this.byMediaAsset(job.id);
      if (existing) {
        db.prepare(`UPDATE media_library_assets SET updated_at = datetime('now') WHERE id = ?`).run(existing.id);
        return this.get(existing.id);
      }
      const id = randomUUID();
      db.prepare(
        `INSERT INTO media_library_assets (id, media_asset_id, title) VALUES (?, ?, ?)`,
      ).run(id, job.id, job.originalName || job.id);
      return this.get(id);
    },
    backfillReady() {
      db.exec(`
        INSERT OR IGNORE INTO media_library_assets (id, media_asset_id, title)
        SELECT id, id, original_name FROM media_assets WHERE status = 'ready';
      `);
    },
    removeCatalog(id) {
      return db.prepare('DELETE FROM media_library_assets WHERE id = ?').run(id).changes > 0;
    },
    tagsFor(assetId) {
      return db.prepare(`
        SELECT t.name FROM media_tags t
        JOIN media_library_asset_tags j ON j.tag_id = t.id
        WHERE j.asset_id = ?
        ORDER BY t.name
      `).all(assetId).map((row) => row.name);
    },
    ensureTag(name) {
      const trimmed = String(name || '').trim();
      if (!trimmed) return null;
      const existing = db.prepare('SELECT id FROM media_tags WHERE name = ?').get(trimmed);
      if (existing) return existing.id;
      const id = randomUUID();
      db.prepare('INSERT INTO media_tags (id, name) VALUES (?, ?)').run(id, trimmed);
      return id;
    },
    setTags(assetId, names) {
      db.prepare('DELETE FROM media_library_asset_tags WHERE asset_id = ?').run(assetId);
      for (const name of names) {
        const tagId = this.ensureTag(name);
        if (!tagId) continue;
        db.prepare('INSERT OR IGNORE INTO media_library_asset_tags (asset_id, tag_id) VALUES (?, ?)').run(assetId, tagId);
      }
      return this.get(assetId);
    },
  };
}
