import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { extname, basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mediaKindDir, mediaTypeFor } from './media.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm']);
const CONVERTIBLE_IMAGE_EXT = new Set([
  '.bmp', '.tif', '.tiff', '.tga', '.psd', '.heic', '.avif', '.ico',
]);

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.tga': 'image/x-tga',
  '.psd': 'image/vnd.adobe.photoshop',
  '.heic': 'image/heic',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

/** In-flight folder scan conversions keyed by absolute path. */
const convertingPaths = new Set();

function rowToAsset(row, tags = [], job = null) {
  if (!row) return null;
  const probe = job?.probe ?? {};
  return {
    id: row.id,
    mediaAssetId: row.media_asset_id,
    title: row.title,
    notes: row.notes,
    locked: Boolean(row.locked),
    type: row.type,
    status: row.status,
    url: row.playback_filename ? `/uploads/${row.playback_filename}` : null,
    posterUrl: row.poster_filename ? `/uploads/${row.poster_filename}` : null,
    originalName: row.original_name,
    token: `asset:${row.media_asset_id}`,
    tags,
    hasAlpha: Boolean(row.has_alpha ?? job?.hasAlpha),
    probe: {
      width: Number(probe.width) || 0,
      height: Number(probe.height) || 0,
      fps: Number(probe.fps) || 0,
      playbackFps: Number(probe.playbackFps) || 0,
      durationSec: Number(probe.durationSec) || 0,
      durationFrames: Number(probe.durationFrames) || 0,
      codec: probe.codec || '',
      pixFmt: probe.pixFmt || '',
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseProbe(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

export function mediaLibraryDao(db) {
  return {
    list({ q = '', tags = [], type = '' } = {}) {
      const tagList = Array.isArray(tags)
        ? tags.map((item) => String(item).trim()).filter(Boolean)
        : String(tags || '').split(',').map((item) => item.trim()).filter(Boolean);
      const rows = db.prepare(`
        SELECT l.*, a.type, a.status, a.original_name, a.playback_filename, a.poster_filename,
               a.has_alpha, a.probe_json
        FROM media_library_assets l
        JOIN media_assets a ON a.id = l.media_asset_id
        WHERE (? = '' OR l.title LIKE ? OR a.original_name LIKE ?)
          AND (? = '' OR a.type = ?)
        ORDER BY l.updated_at DESC
      `).all(q, `%${q}%`, `%${q}%`, type, type);
      return rows
        .map((row) => rowToAsset(row, this.tagsFor(row.id), {
          hasAlpha: Boolean(row.has_alpha),
          probe: parseProbe(row.probe_json),
        }))
        .filter((asset) => tagList.every((tag) => asset.tags.includes(tag)));
    },
    get(id) {
      const row = db.prepare(`
        SELECT l.*, a.type, a.status, a.original_name, a.playback_filename, a.poster_filename,
               a.has_alpha, a.probe_json
        FROM media_library_assets l
        JOIN media_assets a ON a.id = l.media_asset_id
        WHERE l.id = ?
      `).get(id);
      if (!row) return null;
      return rowToAsset(row, this.tagsFor(id), {
        hasAlpha: Boolean(row.has_alpha),
        probe: parseProbe(row.probe_json),
      });
    },
    byMediaAsset(mediaAssetId) {
      const row = db.prepare('SELECT id FROM media_library_assets WHERE media_asset_id = ?').get(mediaAssetId);
      return row ? this.get(row.id) : null;
    },
    byToken(token) {
      const raw = String(token || '').trim();
      const id = raw.startsWith('asset:') ? raw.slice('asset:'.length) : raw;
      if (!id) return null;
      return this.byMediaAsset(id);
    },
    upsertFromJob(job, { title } = {}) {
      const existing = this.byMediaAsset(job.id);
      if (existing) {
        if (title != null && String(title).trim()) {
          db.prepare(
            `UPDATE media_library_assets SET title = ?, updated_at = datetime('now') WHERE id = ?`,
          ).run(String(title).trim(), existing.id);
        } else {
          db.prepare(`UPDATE media_library_assets SET updated_at = datetime('now') WHERE id = ?`).run(existing.id);
        }
        return this.get(existing.id);
      }
      const id = randomUUID();
      db.prepare(
        `INSERT INTO media_library_assets (id, media_asset_id, title) VALUES (?, ?, ?)`,
      ).run(id, job.id, (title && String(title).trim()) || job.originalName || job.id);
      return this.get(id);
    },
    update(id, { title, locked } = {}) {
      const existing = this.get(id);
      if (!existing) return null;
      if (title != null) {
        const next = String(title).trim();
        if (next) {
          db.prepare(
            `UPDATE media_library_assets SET title = ?, updated_at = datetime('now') WHERE id = ?`,
          ).run(next, id);
        }
      }
      if (locked != null) {
        db.prepare(
          `UPDATE media_library_assets SET locked = ?, updated_at = datetime('now') WHERE id = ?`,
        ).run(locked ? 1 : 0, id);
      }
      return this.get(id);
    },
    backfillReady() {
      db.exec(`
        INSERT OR IGNORE INTO media_library_assets (id, media_asset_id, title)
        SELECT id, id, original_name FROM media_assets WHERE status IN ('ready', 'pending', 'processing');
      `);
    },
    knownFilenames() {
      const rows = db.prepare(`
        SELECT source_filename, playback_filename, poster_filename FROM media_assets
      `).all();
      const known = new Set();
      for (const row of rows) {
        for (const name of [row.source_filename, row.playback_filename, row.poster_filename]) {
          if (name) known.add(String(name).replace(/\\/g, '/'));
        }
      }
      return known;
    },
    removeCatalog(id) {
      return db.prepare('DELETE FROM media_library_assets WHERE id = ?').run(id).changes > 0;
    },
    removeAssetAndFiles(id, uploadsDir) {
      const row = db.prepare(`
        SELECT l.id AS catalog_id, l.locked, a.id AS asset_id,
               a.source_filename, a.playback_filename, a.poster_filename
        FROM media_library_assets l
        JOIN media_assets a ON a.id = l.media_asset_id
        WHERE l.id = ?
      `).get(id);
      if (!row) return { ok: false, reason: 'NOT_FOUND' };
      if (row.locked) return { ok: false, reason: 'LOCKED' };
      const files = new Set([row.source_filename, row.playback_filename, row.poster_filename]
        .filter(Boolean)
        .map((name) => String(name).replace(/\\/g, '/')));
      db.prepare('DELETE FROM media_library_assets WHERE id = ?').run(row.catalog_id);
      db.prepare('DELETE FROM media_assets WHERE id = ?').run(row.asset_id);
      for (const name of files) {
        try {
          rmSync(resolve(uploadsDir, name), { force: true });
        } catch {
          // best-effort disk cleanup
        }
      }
      return { ok: true };
    },
    tagsFor(assetId) {
      return db.prepare(`
        SELECT t.name FROM media_tags t
        JOIN media_library_asset_tags j ON j.tag_id = t.id
        WHERE j.asset_id = ?
        ORDER BY t.name
      `).all(assetId).map((row) => row.name);
    },
    listTags({ q = '' } = {}) {
      const query = String(q || '').trim();
      if (!query) {
        return db.prepare(`SELECT id, name, created_at AS createdAt FROM media_tags ORDER BY name`).all();
      }
      return db.prepare(`
        SELECT id, name, created_at AS createdAt FROM media_tags
        WHERE name LIKE ?
        ORDER BY name
      `).all(`%${query}%`);
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
    createTag(name) {
      const trimmed = String(name || '').trim();
      if (!trimmed) return null;
      const existing = db.prepare('SELECT id, name, created_at AS createdAt FROM media_tags WHERE name = ?').get(trimmed);
      if (existing) return existing;
      const id = randomUUID();
      db.prepare('INSERT INTO media_tags (id, name) VALUES (?, ?)').run(id, trimmed);
      return db.prepare('SELECT id, name, created_at AS createdAt FROM media_tags WHERE id = ?').get(id);
    },
    deleteTag(idOrName) {
      const byId = db.prepare('SELECT id, name FROM media_tags WHERE id = ?').get(idOrName);
      const row = byId || db.prepare('SELECT id, name FROM media_tags WHERE name = ?').get(idOrName);
      if (!row) return null;
      // CASCADE clears media_library_asset_tags links.
      db.prepare('DELETE FROM media_tags WHERE id = ?').run(row.id);
      return row;
    },
    setTags(assetId, names) {
      db.prepare('DELETE FROM media_library_asset_tags WHERE asset_id = ?').run(assetId);
      for (const name of names) {
        const tagId = this.ensureTag(name);
        if (!tagId) continue;
        db.prepare('INSERT OR IGNORE INTO media_library_asset_tags (asset_id, tag_id) VALUES (?, ?)').run(assetId, tagId);
      }
      db.prepare(`UPDATE media_library_assets SET updated_at = datetime('now') WHERE id = ?`).run(assetId);
      return this.get(assetId);
    },
  };
}

function mimeForExt(ext) {
  return MIME_BY_EXT[ext] || null;
}

function convertImageToWebp(sourcePath, destPath, ffmpegPath = 'ffmpeg') {
  const result = spawnSync(ffmpegPath, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', sourcePath,
    destPath,
  ], { encoding: 'utf8', timeout: 120_000 });
  if (result.status !== 0) {
    throw new Error(result.stderr || `ffmpeg convert failed for ${basename(sourcePath)}`);
  }
}

/**
 * Scan uploads/images or uploads/video for new files and catalog them.
 * Unsupported image formats are converted to webp; unsupported videos go through MediaJobs.
 */
export async function refreshMediaFolder({
  db,
  media,
  uploadsDir,
  type,
  ffmpegPath = 'ffmpeg',
}) {
  const dao = mediaLibraryDao(db);
  const kindDir = mediaKindDir(type);
  if (!kindDir) return { imported: [], converting: [], errors: [`unknown type ${type}`] };

  const folder = join(uploadsDir, kindDir);
  const known = dao.knownFilenames();
  const imported = [];
  const converting = [];
  const errors = [];

  let entries = [];
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch {
    return { imported, converting, errors };
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name.startsWith('.') || name.includes('.part.')) continue;
    const ext = extname(name).toLowerCase();
    const relativeName = `${kindDir}/${name}`.replace(/\\/g, '/');
    const absolutePath = resolve(folder, name);
    if (known.has(relativeName) || convertingPaths.has(absolutePath)) continue;

    // Skip derived playback/poster names that look like uuid.webp / uuid.jpg for videos.
    if (type === 'video' && (ext === '.webp' || ext === '.jpg') && /^[0-9a-f-]{36}\.(webp|jpg)$/i.test(name)) {
      continue;
    }

    const allowed = type === 'image' ? IMAGE_EXT : VIDEO_EXT;
    const convertible = type === 'image' && CONVERTIBLE_IMAGE_EXT.has(ext);

    if (!allowed.has(ext) && !convertible) {
      // Leave unsupported files alone; surface as error for UI toast.
      errors.push(`unsupported file skipped: ${name}`);
      continue;
    }

    convertingPaths.add(absolutePath);
    try {
      let finalRelative = relativeName;
      let finalAbsolute = absolutePath;
      let finalMime = mimeForExt(ext);
      let finalOriginal = name;
      let size = 0;
      try { size = statSync(absolutePath).size; } catch { size = 0; }

      if (convertible) {
        converting.push({ name, status: 'converting' });
        const webpName = `${name.slice(0, Math.max(0, name.length - ext.length)) || randomUUID()}.webp`;
        const webpRelative = `${kindDir}/${webpName}`;
        const webpAbsolute = resolve(folder, webpName);
        if (known.has(webpRelative) || existsSync(webpAbsolute)) {
          // Destination already cataloged/present — drop the unsupported source.
          rmSync(absolutePath, { force: true });
          continue;
        }
        convertImageToWebp(absolutePath, webpAbsolute, ffmpegPath);
        rmSync(absolutePath, { force: true });
        finalRelative = webpRelative;
        finalAbsolute = webpAbsolute;
        finalMime = 'image/webp';
        finalOriginal = webpName;
        try { size = statSync(webpAbsolute).size; } catch { size = 0; }
      }

      if (!finalMime || mediaTypeFor(finalMime) !== type) {
        errors.push(`could not determine mime for ${name}`);
        continue;
      }

      const job = media.ingestExistingPath({
        absolutePath: finalAbsolute,
        relativeName: finalRelative,
        originalName: finalOriginal,
        mimetype: finalMime,
        size,
      });
      const catalog = dao.upsertFromJob(job, { title: finalOriginal.replace(extname(finalOriginal), '') || finalOriginal });
      imported.push(catalog);
      known.add(finalRelative);
      if (job.playbackFilename) known.add(job.playbackFilename);
      if (job.posterFilename) known.add(job.posterFilename);
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      convertingPaths.delete(absolutePath);
    }
  }

  dao.backfillReady();
  return { imported, converting, errors };
}
