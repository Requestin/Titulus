import { Router } from 'express';
import multer from 'multer';
import { mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mediaKindDir, mediaTypeFor } from '../media.js';
import { mediaLibraryDao, refreshMediaFolder } from '../mediaLibrary.js';

function apiError(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

export function mediaLibraryRouter({ db, media, uploadsDir }) {
  const dao = mediaLibraryDao(db);
  const router = Router();

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const kind = mediaTypeFor(file.mimetype) || 'image';
      const sub = mediaKindDir(kind) || 'images';
      const dest = join(uploadsDir, sub);
      mkdirSync(dest, { recursive: true });
      cb(null, dest);
    },
    filename: (req, file, cb) => {
      const ext = (extname(file.originalname) || '').toLowerCase().replace(/[^.a-z0-9]/g, '');
      cb(null, `${randomUUID()}${ext}`);
    },
  });
  const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

  router.get('/tags', (req, res) => {
    res.json(dao.listTags({ q: String(req.query.q || '') }));
  });

  router.post('/tags', (req, res) => {
    const tag = dao.createTag(req.body?.name);
    if (!tag) return apiError(res, 400, 'TAG_REQUIRED', 'tag name is required');
    res.status(201).json(tag);
  });

  router.delete('/tags/:id', (req, res) => {
    const removed = dao.deleteTag(req.params.id);
    if (!removed) return apiError(res, 404, 'NOT_FOUND', 'tag not found');
    res.json({ ok: true, tag: removed });
  });

  router.post('/refresh', async (req, res) => {
    const type = String(req.body?.type || req.query.type || '').trim();
    if (type !== 'image' && type !== 'video') {
      return apiError(res, 400, 'TYPE_REQUIRED', 'type must be image or video');
    }
    try {
      const result = await refreshMediaFolder({ db, media, uploadsDir, type });
      dao.backfillReady();
      res.json({
        ...result,
        items: dao.list({ type }),
      });
    } catch (error) {
      return apiError(res, 500, 'REFRESH_FAILED', error instanceof Error ? error.message : 'refresh failed');
    }
  });

  router.get('/resolve', (req, res) => {
    const token = String(req.query.token || '');
    const row = dao.byToken(token);
    if (!row) return apiError(res, 404, 'NOT_FOUND', 'media asset not found');
    res.json(row);
  });

  router.get('/', (req, res) => {
    dao.backfillReady();
    const tags = String(req.query.tags || req.query.tag || '');
    res.json(dao.list({
      q: String(req.query.q || ''),
      tags,
      type: String(req.query.type || ''),
    }));
  });

  router.post('/import', (req, res) => {
    upload.single('file')(req, res, (err) => {
      if (err) return apiError(res, 400, 'UPLOAD_FAILED', err.message);
      if (!req.file) return apiError(res, 400, 'FILE_REQUIRED', 'multipart field "file" required');
      const kind = mediaTypeFor(req.file.mimetype);
      if (!kind) return apiError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', `unsupported media type: ${req.file.mimetype}`);
      const sub = mediaKindDir(kind);
      req.file.relativeName = `${sub}/${req.file.filename}`;
      const job = media.ingest(req.file);
      const catalog = dao.upsertFromJob(job);
      res.status(job.status === 'error' ? 422 : 201).json({ catalog, job });
    });
  });

  router.get('/:id', (req, res) => {
    const row = dao.get(req.params.id);
    if (!row) return apiError(res, 404, 'NOT_FOUND', 'media asset not found');
    res.json(row);
  });

  router.put('/:id', (req, res) => {
    const updated = dao.update(req.params.id, {
      title: req.body?.title,
      locked: req.body?.locked,
    });
    if (!updated) return apiError(res, 404, 'NOT_FOUND', 'media asset not found');
    if (Array.isArray(req.body?.tags)) {
      return res.json(dao.setTags(req.params.id, req.body.tags.map(String)));
    }
    res.json(updated);
  });

  router.put('/:id/tags', (req, res) => {
    const names = Array.isArray(req.body?.tags) ? req.body.tags.map(String) : [];
    const row = dao.setTags(req.params.id, names);
    if (!row) return apiError(res, 404, 'NOT_FOUND', 'media asset not found');
    res.json(row);
  });

  router.post('/:id/refresh', (req, res) => {
    const row = dao.get(req.params.id);
    if (!row) return apiError(res, 404, 'NOT_FOUND', 'media asset not found');
    dao.backfillReady();
    res.json(dao.get(req.params.id));
  });

  router.delete('/:id', (req, res) => {
    const purge = String(req.query.purge || '1') !== '0';
    if (purge) {
      const result = dao.removeAssetAndFiles(req.params.id, uploadsDir);
      if (!result.ok && result.reason === 'LOCKED') {
        return apiError(res, 409, 'LOCKED', 'asset is locked');
      }
      if (!result.ok) return apiError(res, 404, 'NOT_FOUND', 'media asset not found');
      return res.json({ ok: true });
    }
    if (!dao.removeCatalog(req.params.id)) return apiError(res, 404, 'NOT_FOUND', 'media asset not found');
    res.json({ ok: true });
  });

  return router;
}
