// backend/src/routes/media.js — media library REST (tags, assets, import, refresh).

import { Router } from 'express';
import multer from 'multer';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mediaTagsDao, mediaAssetsDao } from '../db.js';
import { mediaTypeFor } from '../media.js';
import { IMAGE_FOLDER, VIDEO_FOLDER } from '../mediaLibrary.js';

const MAX_BYTES = 200 * 1024 * 1024;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp', '.tiff', '.tif', '.heic', '.heif', '.avif']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm']);

function apiError(res, status, code, message, details) {
  return res.status(status).json({
    error: { code, message, details: details || null },
  });
}

export function mediaRouter(library, uploadsDir) {
  const router = Router();
  const tags = (db) => mediaTagsDao(db);
  const assets = (db) => mediaAssetsDao(db);

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const kind = mediaTypeFor(file.mimetype);
      const sub = kind === 'image' ? IMAGE_FOLDER : VIDEO_FOLDER;
      const dest = join(uploadsDir, sub);
      cb(null, dest);
    },
    filename: (req, file, cb) => {
      const ext = (extname(file.originalname) || '').toLowerCase().replace(/[^.a-z0-9]/g, '');
      cb(null, `${randomUUID()}${ext}`);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: MAX_BYTES },
    fileFilter: (req, file, cb) => {
      const kind = mediaTypeFor(file.mimetype);
      if (!kind) {
        const err = new Error(`unsupported media type: ${file.mimetype}`);
        err.code = 'UNSUPPORTED_TYPE';
        return cb(err);
      }
      const ext = (extname(file.originalname) || '').toLowerCase();
      const allowed = kind === 'image' ? IMAGE_EXT : VIDEO_EXT;
      if (!allowed.has(ext)) {
        const err = new Error(`unsupported file extension: ${ext || '(none)'}`);
        err.code = 'UNSUPPORTED_EXTENSION';
        return cb(err);
      }
      cb(null, true);
    },
  });

  router.get('/tags', (req, res) => {
    const db = req.app.locals.db;
    const search = typeof req.query.q === 'string' ? req.query.q : '';
    res.json(tags(db).all(search).map((t) => ({
      id: t.id, name: t.name, createdAt: t.created_at,
    })));
  });

  router.post('/tags', (req, res) => {
    const db = req.app.locals.db;
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) return apiError(res, 400, 'NAME_REQUIRED', 'tag name required');
    const tag = tags(db).create(name);
    if (!tag) return apiError(res, 400, 'INVALID_NAME', 'invalid tag name');
    res.status(201).json({ id: tag.id, name: tag.name, createdAt: tag.created_at });
  });

  router.delete('/tags/:id', (req, res) => {
    const db = req.app.locals.db;
    const row = tags(db).get(req.params.id);
    if (!row) return apiError(res, 404, 'TAG_NOT_FOUND', 'tag not found');
    tags(db).remove(req.params.id);
    res.json({ ok: true, id: req.params.id, name: row.name });
  });

  router.get('/', (req, res) => {
    const db = req.app.locals.db;
    const type = req.query.type === 'image' || req.query.type === 'video' ? req.query.type : undefined;
    const search = typeof req.query.q === 'string' ? req.query.q : '';
    const tagIds = typeof req.query.tags === 'string' && req.query.tags
      ? req.query.tags.split(',').filter(Boolean)
      : [];
    res.json(assets(db).list({ type, search, tagIds }));
  });

  router.get('/lookup', (req, res) => {
    const db = req.app.locals.db;
    const url = typeof req.query.url === 'string' ? req.query.url : '';
    const rel = url.replace(/^\/uploads\//, '');
    if (!rel) return apiError(res, 400, 'URL_REQUIRED', 'url query required');
    const asset = assets(db).getByRelativePath(rel);
    if (!asset) return apiError(res, 404, 'ASSET_NOT_FOUND', 'asset not found');
    res.json(asset);
  });

  router.get('/:id', (req, res) => {
    const db = req.app.locals.db;
    const asset = assets(db).get(req.params.id);
    if (!asset) return apiError(res, 404, 'ASSET_NOT_FOUND', 'asset not found');
    res.json(asset);
  });

  router.patch('/:id', (req, res) => {
    const db = req.app.locals.db;
    const body = req.body || {};
    const patch = {};
    if (typeof body.displayName === 'string') patch.displayName = body.displayName;
    if (typeof body.locked === 'boolean') patch.locked = body.locked;
    if (Array.isArray(body.tagIds)) patch.tagIds = body.tagIds.filter((x) => typeof x === 'string');
    const asset = assets(db).update(req.params.id, patch);
    if (!asset) return apiError(res, 404, 'ASSET_NOT_FOUND', 'asset not found');
    res.json(asset);
  });

  router.delete('/:id', (req, res) => {
    const db = req.app.locals.db;
    try {
      const ok = library.deleteAsset(assets(db), req.params.id);
      if (!ok) return apiError(res, 404, 'ASSET_NOT_FOUND', 'asset not found');
      res.json({ ok: true });
    } catch (e) {
      if (e.code === 'ASSET_LOCKED') {
        return apiError(res, 409, 'ASSET_LOCKED', 'asset is locked');
      }
      throw e;
    }
  });

  router.post('/import', (req, res) => {
    upload.single('file')(req, res, async (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return apiError(res, 413, 'FILE_TOO_LARGE', 'file too large (max 200 MB)');
        }
        return apiError(res, 400, 'UPLOAD_FAILED', err.message || 'upload failed');
      }
      if (!req.file) {
        return apiError(res, 400, 'FILE_REQUIRED', 'multipart field "file" required');
      }
      const db = req.app.locals.db;
      let tagIds = [];
      if (typeof req.body?.tagIds === 'string' && req.body.tagIds) {
        try { tagIds = JSON.parse(req.body.tagIds); } catch { tagIds = []; }
      }
      const displayName = typeof req.body?.displayName === 'string' ? req.body.displayName : undefined;
      try {
        const result = await library.importFile(req.file, assets(db), { displayName, tagIds });
        if (result.job?.status === 'error') {
          return res.status(422).json({
            asset: result.asset,
            job: result.job,
            error: result.job.error,
          });
        }
        if (result.job && result.job.status !== 'ready' && !result.asset) {
          return res.status(202).json({
            asset: null,
            job: result.job,
          });
        }
        res.status(201).json(result);
      } catch (e) {
        return apiError(res, 400, e.code || 'IMPORT_FAILED', e.message || 'import failed');
      }
    });
  });

  router.post('/refresh', async (req, res) => {
    const db = req.app.locals.db;
    const type = req.query.type === 'image' || req.query.type === 'video' ? req.query.type : null;
    if (!type) return apiError(res, 400, 'TYPE_REQUIRED', 'query type=image|video required');
    try {
      const imported = await library.refresh(assets(db), type);
      res.json({ imported, count: imported.length });
    } catch (e) {
      return apiError(res, 500, 'REFRESH_FAILED', e.message || 'refresh failed');
    }
  });

  router.post('/finalize-job', async (req, res) => {
    const db = req.app.locals.db;
    const jobId = typeof req.body?.jobId === 'string' ? req.body.jobId : '';
    if (!jobId) return apiError(res, 400, 'JOB_ID_REQUIRED', 'jobId required');
    let tagIds = [];
    if (Array.isArray(req.body?.tagIds)) tagIds = req.body.tagIds;
    const displayName = typeof req.body?.displayName === 'string' ? req.body.displayName : undefined;
    try {
      const asset = await library.finalizeJob(assets(db), jobId, { displayName, tagIds });
      res.status(201).json({ asset, job: req.app.locals.media.get(jobId) });
    } catch (e) {
      return apiError(res, 400, e.code || 'FINALIZE_FAILED', e.message || 'finalize failed');
    }
  });

  return router;
}
