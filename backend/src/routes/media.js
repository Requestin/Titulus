import { Router } from 'express';
import multer from 'multer';
import { mediaLibraryDao } from '../mediaLibrary.js';

function apiError(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

export function mediaLibraryRouter({ db, media, uploadsDir }) {
  const dao = mediaLibraryDao(db);
  const router = Router();
  const upload = multer({ dest: uploadsDir, limits: { fileSize: 200 * 1024 * 1024 } });

  router.get('/', (req, res) => {
    dao.backfillReady();
    res.json(dao.list({ q: String(req.query.q || ''), tag: String(req.query.tag || '') }));
  });

  router.get('/:id', (req, res) => {
    const row = dao.get(req.params.id);
    if (!row) return apiError(res, 404, 'NOT_FOUND', 'media asset not found');
    res.json(row);
  });

  router.post('/import', (req, res) => {
    upload.single('file')(req, res, (err) => {
      if (err) return apiError(res, 400, 'UPLOAD_FAILED', err.message);
      if (!req.file) return apiError(res, 400, 'FILE_REQUIRED', 'multipart field "file" required');
      const job = media.ingest(req.file);
      const catalog = dao.upsertFromJob(job);
      res.status(job.status === 'error' ? 422 : 201).json({ catalog, job });
    });
  });

  router.post('/:id/refresh', (req, res) => {
    const row = dao.get(req.params.id);
    if (!row) return apiError(res, 404, 'NOT_FOUND', 'media asset not found');
    dao.backfillReady();
    res.json(dao.get(req.params.id));
  });

  router.put('/:id/tags', (req, res) => {
    const names = Array.isArray(req.body?.tags) ? req.body.tags.map(String) : [];
    const row = dao.setTags(req.params.id, names);
    if (!row) return apiError(res, 404, 'NOT_FOUND', 'media asset not found');
    res.json(row);
  });

  router.delete('/:id', (req, res) => {
    if (!dao.removeCatalog(req.params.id)) return apiError(res, 404, 'NOT_FOUND', 'media asset not found');
    res.json({ ok: true });
  });

  return router;
}
