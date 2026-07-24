// backend/src/mediaLibrary.js — persisted media library in uploads/Image and uploads/Video.

import { spawn } from 'node:child_process';
import {
  mkdirSync, readdirSync, unlinkSync, renameSync, existsSync, statSync,
} from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mediaTypeFor } from './media.js';
import { probeMediaFile } from './mediaProbe.js';

export const IMAGE_FOLDER = 'Image';
export const VIDEO_FOLDER = 'Video';

const IMAGE_EXT_OK = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
const VIDEO_EXT_OK = new Set(['.webm']);
const VIDEO_EXT_TRANSCODE = new Set(['.mp4', '.mov']);
const IMAGE_EXT_CONVERT = new Set(['.bmp', '.tiff', '.tif', '.heic', '.heif', '.avif']);

function sanitizeBaseName(name) {
  return basename(name, extname(name))
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'asset';
}

function uniqueFilename(dir, base, ext) {
  let candidate = `${base}${ext}`;
  let n = 1;
  while (existsSync(join(dir, candidate))) {
    candidate = `${base}_${n}${ext}`;
    n += 1;
  }
  return candidate;
}

function displayNameFromFilename(filename) {
  return basename(filename, extname(filename));
}

export class MediaLibrary {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {string} uploadsDir
   * @param {import('./media.js').MediaJobs} mediaJobs
   */
  constructor(db, uploadsDir, mediaJobs) {
    this.db = db;
    this.uploadsDir = uploadsDir;
    this.mediaJobs = mediaJobs;
    this.tagsDao = null;
    this.assetsDao = null;
    mkdirSync(join(uploadsDir, IMAGE_FOLDER), { recursive: true });
    mkdirSync(join(uploadsDir, VIDEO_FOLDER), { recursive: true });
  }

  /** @param {ReturnType<import('./db.js').mediaTagsDao>} tagsDao */
  /** @param {ReturnType<import('./db.js').mediaAssetsDao>} assetsDao */
  bindDaos(tagsDao, assetsDao) {
    this.tagsDao = tagsDao;
    this.assetsDao = assetsDao;
  }

  folderForType(type) {
    return type === 'image' ? IMAGE_FOLDER : VIDEO_FOLDER;
  }

  typeDir(type) {
    return join(this.uploadsDir, this.folderForType(type));
  }

  /**
   * @param {import('./db.js').mediaTagsDao} tagsDao
   */
  listTags(tagsDao, search = '') {
    return tagsDao.all(search).map((t) => ({ id: t.id, name: t.name, createdAt: t.created_at }));
  }

  /**
   * @param {import('./db.js').mediaAssetsDao} assetsDao
   */
  listAssets(assetsDao, { type, search, tagIds }) {
    return assetsDao.list({ type, search, tagIds });
  }

  /**
   * Import uploaded multer file into library.
   * @param {{ path: string, filename: string, originalname: string, mimetype: string, size: number }} file
   */
  async importFile(file, assetsDao, { displayName, tagIds = [] } = {}) {
    const type = mediaTypeFor(file.mimetype);
    if (!type) throw Object.assign(new Error('unsupported media type'), { code: 'UNSUPPORTED_TYPE' });

    const ext = extname(file.originalname).toLowerCase();
    const dir = this.typeDir(type);

    if (type === 'image') {
      let destPath = file.path;
      let destName = file.filename;
      let destExt = ext;

      if (!IMAGE_EXT_OK.has(ext)) {
        const converted = await this._convertImage(file.path, dir);
        try { unlinkSync(file.path); } catch { /* ignore */ }
        destPath = converted.path;
        destName = converted.filename;
        destExt = converted.ext;
      } else {
        const base = sanitizeBaseName(file.originalname);
        destName = uniqueFilename(dir, base, ext);
        const target = join(dir, destName);
        renameSync(file.path, target);
        destPath = target;
      }

      const meta = await probeMediaFile(destPath);
      const relativePath = `${IMAGE_FOLDER}/${destName}`;
      const id = randomUUID();
      const asset = assetsDao.create({
        id,
        type: 'image',
        displayName: displayName?.trim() || displayNameFromFilename(destName),
        filename: destName,
        relativePath,
        format: meta?.format || destExt.replace('.', ''),
        width: meta?.width ?? 0,
        height: meta?.height ?? 0,
        hasAlpha: meta?.hasAlpha ?? (destExt === '.png' || destExt === '.webp' || destExt === '.gif'),
        tagIds,
      });
      return { asset, job: null };
    }

    // video
    const extLower = ext;
    if (VIDEO_EXT_OK.has(extLower)) {
      const base = sanitizeBaseName(file.originalname);
      const destName = uniqueFilename(dir, base, extLower);
      const target = join(dir, destName);
      renameSync(file.path, target);
      const meta = await probeMediaFile(target);
      const poster = await this._makePoster(target, dir, basename(destName, extLower));
      const id = randomUUID();
      const asset = assetsDao.create({
        id,
        type: 'video',
        displayName: displayName?.trim() || displayNameFromFilename(destName),
        filename: destName,
        relativePath: `${VIDEO_FOLDER}/${destName}`,
        posterPath: poster ? `${VIDEO_FOLDER}/${poster}` : null,
        format: meta?.format || 'webm',
        width: meta?.width ?? 0,
        height: meta?.height ?? 0,
        hasAlpha: meta?.hasAlpha ?? true,
        durationSec: meta?.durationSec ?? 0,
        durationFrames: meta?.durationFrames ?? 0,
        fps: meta?.fps ?? 0,
        tagIds,
      });
      return { asset, job: null };
    }

    if (VIDEO_EXT_TRANSCODE.has(extLower)) {
      const job = this.mediaJobs.ingestTo(dir, file);
      return { asset: null, job };
    }

    throw Object.assign(new Error(`unsupported video extension: ${ext}`), { code: 'UNSUPPORTED_EXTENSION' });
  }

  /**
   * Register a completed transcode job as a library asset.
   */
  async finalizeJob(assetsDao, jobId, { displayName, tagIds = [] } = {}) {
    const job = this.mediaJobs.get(jobId);
    if (!job || job.status !== 'ready') {
      throw Object.assign(new Error('job not ready'), { code: 'JOB_NOT_READY' });
    }
    const rel = job.url.replace('/uploads/', '');
    const outPath = join(this.uploadsDir, rel);
    const meta = await probeMediaFile(outPath);
    const posterRel = job.posterUrl?.replace('/uploads/', '') ?? null;

    const existing = assetsDao.get(jobId);
    if (existing?.status === 'processing') {
      const updated = assetsDao.update(jobId, {
        displayName: displayName?.trim() || existing.displayName,
        format: meta?.format || 'webm',
        width: meta?.width ?? 0,
        height: meta?.height ?? 0,
        hasAlpha: meta?.hasAlpha ?? true,
        durationSec: meta?.durationSec ?? 0,
        durationFrames: meta?.durationFrames ?? 0,
        fps: meta?.fps ?? 0,
        posterPath: posterRel,
        locked: false,
        status: 'ready',
        sourceRelativePath: null,
        tagIds,
      });
      return updated;
    }

    if (existing) return existing;

    return assetsDao.create({
      id: jobId,
      type: 'video',
      displayName: displayName?.trim() || displayNameFromFilename(job.originalName),
      filename: basename(outPath),
      relativePath: rel,
      posterPath: posterRel,
      format: meta?.format || 'webm',
      width: meta?.width ?? 0,
      height: meta?.height ?? 0,
      hasAlpha: meta?.hasAlpha ?? true,
      durationSec: meta?.durationSec ?? 0,
      durationFrames: meta?.durationFrames ?? 0,
      fps: meta?.fps ?? 0,
      tagIds,
    });
  }

  /**
   * Start async video transcode; returns a locked processing placeholder immediately.
   */
  _startVideoTranscode(assetsDao, fakeFile, sourceRelativePath) {
    const dir = this.typeDir('video');
    const job = this.mediaJobs.ingestTo(dir, fakeFile);
    const asset = assetsDao.create({
      id: job.id,
      type: 'video',
      displayName: displayNameFromFilename(fakeFile.originalname),
      filename: `${job.id}.webm`,
      relativePath: `${VIDEO_FOLDER}/${job.id}.webm`,
      posterPath: `${VIDEO_FOLDER}/${job.id}.jpg`,
      format: 'webm',
      width: 0,
      height: 0,
      hasAlpha: true,
      locked: true,
      status: 'processing',
      sourceRelativePath,
    });
    void this._finishTranscodeJob(assetsDao, job.id);
    return asset;
  }

  async _finishTranscodeJob(assetsDao, jobId) {
    const done = await this._waitForJob(jobId);
    if (done?.status === 'ready') {
      try {
        await this.finalizeJob(assetsDao, jobId);
      } catch {
        assetsDao.update(jobId, { status: 'error', locked: true });
      }
      return;
    }
    assetsDao.update(jobId, { status: 'error', locked: true });
  }

  /**
   * Scan folder for files not yet in DB; convert unsupported formats.
   * Also repair missing/corrupt posters for existing video assets.
   */
  async refresh(assetsDao, type) {
    const dir = this.typeDir(type);
    const entries = readdirSync(dir, { withFileTypes: true });
    const imported = [];
    let repaired = 0;

    if (type === 'video') {
      repaired = await this._repairMissingPosters(assetsDao);
    }

    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const filename = ent.name;
      const ext = extname(filename).toLowerCase();
      const relativePath = `${this.folderForType(type)}/${filename}`;

      // Skip poster JPEGs generated alongside videos.
      if (type === 'video' && (filename.includes('_poster') || ext === '.jpg' || ext === '.jpeg')) {
        continue;
      }

      if (assetsDao.getByRelativePath(relativePath)) continue;

      const fullPath = join(dir, filename);

      if (type === 'image') {
        if (IMAGE_EXT_CONVERT.has(ext) || !IMAGE_EXT_OK.has(ext)) {
          const converted = await this._convertImage(fullPath, dir);
          try { unlinkSync(fullPath); } catch { /* ignore */ }
          const meta = await probeMediaFile(converted.path);
          imported.push(assetsDao.create({
            id: randomUUID(),
            type: 'image',
            displayName: displayNameFromFilename(converted.filename),
            filename: converted.filename,
            relativePath: `${IMAGE_FOLDER}/${converted.filename}`,
            format: meta?.format || 'png',
            width: meta?.width ?? 0,
            height: meta?.height ?? 0,
            hasAlpha: meta?.hasAlpha ?? true,
          }));
          continue;
        }
        const meta = await probeMediaFile(fullPath);
        imported.push(assetsDao.create({
          id: randomUUID(),
          type: 'image',
          displayName: displayNameFromFilename(filename),
          filename,
          relativePath,
          format: meta?.format || ext.replace('.', ''),
          width: meta?.width ?? 0,
          height: meta?.height ?? 0,
          hasAlpha: meta?.hasAlpha ?? false,
        }));
        continue;
      }

      // video refresh — start transcode, show locked placeholder immediately
      if (VIDEO_EXT_TRANSCODE.has(ext)) {
        if (assetsDao.getProcessingBySource(relativePath)) continue;
        const fakeFile = {
          path: fullPath,
          filename,
          originalname: filename,
          mimetype: ext === '.mov' ? 'video/quicktime' : 'video/mp4',
          size: statSync(fullPath).size,
        };
        imported.push(this._startVideoTranscode(assetsDao, fakeFile, relativePath));
        continue;
      }

      if (VIDEO_EXT_OK.has(ext)) {
        const meta = await probeMediaFile(fullPath);
        const poster = await this._makePoster(fullPath, dir, basename(filename, ext));
        imported.push(assetsDao.create({
          id: randomUUID(),
          type: 'video',
          displayName: displayNameFromFilename(filename),
          filename,
          relativePath,
          posterPath: poster ? `${VIDEO_FOLDER}/${poster}` : null,
          format: meta?.format || 'webm',
          width: meta?.width ?? 0,
          height: meta?.height ?? 0,
          hasAlpha: meta?.hasAlpha ?? true,
          durationSec: meta?.durationSec ?? 0,
          durationFrames: meta?.durationFrames ?? 0,
          fps: meta?.fps ?? 0,
        }));
      } else {
        try { unlinkSync(fullPath); } catch { /* ignore unsupported */ }
      }
    }

    return { imported, repaired };
  }

  /**
   * Regenerate poster_path when missing or file deleted on disk.
   * Covers legacy assets whose posters were lost after TITULUS_DATA / folder moves.
   */
  async _repairMissingPosters(assetsDao) {
    const list = typeof assetsDao.list === 'function'
      ? assetsDao.list({ type: 'video' })
      : [];
    let repaired = 0;
    for (const asset of list) {
      if (asset.status === 'processing') continue;
      const videoPath = join(this.uploadsDir, asset.relativePath);
      if (!existsSync(videoPath)) continue;

      const posterOk = asset.posterPath
        && existsSync(join(this.uploadsDir, asset.posterPath));
      if (posterOk) continue;

      const base = basename(asset.filename, extname(asset.filename));
      const dir = this.typeDir('video');
      const posterName = await this._makePoster(videoPath, dir, base, { overwrite: true });
      if (!posterName) continue;
      assetsDao.update(asset.id, { posterPath: `${VIDEO_FOLDER}/${posterName}` });
      repaired += 1;
    }
    return repaired;
  }

  async regeneratePoster(assetsDao, id) {
    const asset = assetsDao.get(id);
    if (!asset || asset.type !== 'video') return null;
    const videoPath = join(this.uploadsDir, asset.relativePath);
    if (!existsSync(videoPath)) {
      throw Object.assign(new Error('video file missing on disk'), { code: 'FILE_MISSING' });
    }
    const base = basename(asset.filename, extname(asset.filename));
    const dir = this.typeDir('video');
    const posterName = await this._makePoster(videoPath, dir, base, { overwrite: true });
    if (!posterName) return null;
    return assetsDao.update(id, { posterPath: `${VIDEO_FOLDER}/${posterName}` });
  }

  _waitForJob(jobId, timeoutMs = 12 * 60 * 1000) {
    const start = Date.now();
    return new Promise((resolve) => {
      const poll = () => {
        const job = this.mediaJobs.get(jobId);
        if (!job || job.status === 'ready' || job.status === 'error') {
          resolve(job ?? null);
          return;
        }
        if (Date.now() - start > timeoutMs) {
          resolve(job);
          return;
        }
        setTimeout(poll, 500);
      };
      poll();
    });
  }

  deleteAsset(assetsDao, id) {
    const asset = assetsDao.get(id);
    if (!asset) return false;
    if (asset.locked) {
      throw Object.assign(new Error('asset is locked'), { code: 'ASSET_LOCKED' });
    }
    const mainPath = join(this.uploadsDir, asset.relativePath);
    try { if (existsSync(mainPath)) unlinkSync(mainPath); } catch { /* ignore */ }
    if (asset.posterPath) {
      const posterPath = join(this.uploadsDir, asset.posterPath);
      try { if (existsSync(posterPath)) unlinkSync(posterPath); } catch { /* ignore */ }
    }
    return assetsDao.remove(id);
  }

  _convertImage(srcPath, dir) {
    const base = sanitizeBaseName(basename(srcPath));
    const filename = uniqueFilename(dir, base, '.png');
    const outPath = join(dir, filename);
    return new Promise((resolvePromise, reject) => {
      const ff = spawn('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', srcPath,
        '-vf', 'format=rgba',
        outPath,
      ]);
      ff.on('error', reject);
      ff.on('close', (code) => {
        if (code !== 0) return reject(new Error(`image convert failed: ${code}`));
        resolvePromise({ path: outPath, filename, ext: '.png' });
      });
    });
  }

  async _makePoster(videoPath, dir, base, { overwrite = false } = {}) {
    const posterName = overwrite
      ? `${base}_poster.jpg`
      : uniqueFilename(dir, `${base}_poster`, '.jpg');
    const posterPath = join(dir, posterName);
    return new Promise((resolvePromise) => {
      const ff = spawn('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', videoPath, '-frames:v', '1', '-q:v', '3', posterPath,
      ]);
      ff.on('error', () => resolvePromise(null));
      ff.on('close', (code) => resolvePromise(code === 0 ? posterName : null));
    });
  }
}
