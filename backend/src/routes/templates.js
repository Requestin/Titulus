// backend/src/routes/templates.js
//
// REST API for templates (DEVELOPMENT_PROMPT §7.3):
//   GET    /api/templates            list (id/name/timestamps/thumbnailUrl)
//   POST   /api/templates            create (validates against schema)
//   GET    /api/templates/:id        full template (with data)
//   PUT    /api/templates/:id        update
//   PUT    /api/templates/:id/thumbnail  upload JPEG preview (mid-timeline)
//   DELETE /api/templates/:id        delete
//   GET    /api/templates/schema      the JSON Schema
//   POST   /api/templates/validate    validate a body, return 200 {valid:true}
//                                     or 422 {valid:false,error:{code,message,details}}

import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { validateTemplate, schema, templateValidationErrorPayload } from '../templateValidation.js';
import { dataElementsDao } from '../dataElementsDb.js';
import { templatesDao as templatesRouterDao, templateLocksDao } from '../db.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('better-sqlite3').Database | null} dataElementsDb
 * @param {{
 *   dataDir?: string,
 *   thumbnailExists?: (id: string) => boolean,
 *   thumbnailUrl?: (id: string, bust?: string|number) => string,
 *   saveThumbnail?: (id: string, buf: Buffer) => string,
 *   removeThumbnail?: (id: string) => void,
 *   decodeImagePayload?: (body: unknown) => Buffer | null,
 *   regenerateThumbnail?: (template: object) => Promise<string>,
 * }} [thumb]
 */
export function templatesRouter(db, dataElementsDb = null, thumb = {}) {
  const dao = templatesRouterDao(db);
  const locks = templateLocksDao(db);
  const deDao = dataElementsDb ? dataElementsDao(dataElementsDb) : null;
  const router = Router();

  function withThumb(row) {
    if (!row) return row;
    const has = thumb.thumbnailExists?.(row.id);
    return {
      ...row,
      thumbnailUrl: has
        ? thumb.thumbnailUrl?.(row.id, row.updated_at || row.updatedAt || Date.now())
        : null,
    };
  }

  router.get('/', (req, res) => {
    const folderId = typeof req.query.folderId === 'string' ? req.query.folderId : undefined;
    res.json(dao.all({ folderId }).map(withThumb));
  });

  router.post('/', (req, res) => {
    const { name, data, folderId } = req.body ?? {};
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: { code: 'NAME_REQUIRED', message: 'name required' } });
    }
    if (!data || typeof data !== 'object') {
      return res.status(400).json({
        error: { code: 'TEMPLATE_DATA_REQUIRED', message: 'data (Template object) required' },
      });
    }
    const { valid, errors } = validateTemplate(data);
    if (!valid) {
      return res.status(422).json({ error: templateValidationErrorPayload(errors) });
    }
    const id = data.id || uuid();
    const created = dao.create({
      id,
      name,
      data,
      folderId: typeof folderId === 'string' && folderId ? folderId : null,
    });
    res.status(201).json(withThumb(created));
  });

  router.get('/schema', (req, res) => {
    res.json(schema);
  });

  router.post('/validate', (req, res) => {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_BODY_REQUIRED',
          message: 'template object required as request body',
        },
      });
    }
    const { valid, errors } = validateTemplate(req.body);
    return res.status(200).json({ valid, errors });
  });

  router.get('/:id', (req, res) => {
    const t = dao.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    res.json(withThumb(t));
  });

  router.get('/:id/lock', (req, res) => {
    const t = dao.get(req.params.id);
    if (!t) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'template not found' } });
    const lock = locks.getLock(req.params.id);
    return res.json({
      lock,
      isOwner: !!(lock && req.auth && lock.userId === req.auth.userId),
    });
  });

  router.post('/:id/lock', (req, res) => {
    const t = dao.get(req.params.id);
    if (!t) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'template not found' } });
    if (!req.auth?.userId) {
      return res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'authentication required' } });
    }

    let lock = locks.acquireLock(req.params.id, req.auth.userId, req.auth.username);
    if (!lock) {
      lock = locks.stealStaleLock(req.params.id, req.auth.userId, req.auth.username);
    }
    if (!lock) {
      const held = locks.getLock(req.params.id);
      return res.status(409).json({
        error: {
          code: 'TEMPLATE_LOCKED',
          message: 'template is locked by another user',
        },
        lock: held,
      });
    }
    return res.json({ lock, isOwner: true });
  });

  router.post('/:id/lock/heartbeat', (req, res) => {
    const t = dao.get(req.params.id);
    if (!t) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'template not found' } });
    if (!req.auth?.userId) {
      return res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'authentication required' } });
    }
    const lock = locks.heartbeatLock(req.params.id, req.auth.userId);
    if (!lock) {
      const held = locks.getLock(req.params.id);
      return res.status(409).json({
        error: {
          code: 'LOCK_NOT_OWNED',
          message: 'lock heartbeat requires ownership',
        },
        lock: held,
      });
    }
    return res.json({ lock, isOwner: true });
  });

  router.delete('/:id/lock', (req, res) => {
    const t = dao.get(req.params.id);
    if (!t) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'template not found' } });
    if (!req.auth?.userId) {
      return res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'authentication required' } });
    }
    const ok = locks.releaseLock(req.params.id, req.auth.userId);
    if (!ok) {
      const held = locks.getLock(req.params.id);
      if (!held) return res.json({ ok: true });
      return res.status(409).json({
        error: {
          code: 'LOCK_NOT_OWNED',
          message: 'only the lock owner can release the lock',
        },
        lock: held,
      });
    }
    return res.json({ ok: true });
  });

  router.put('/:id/thumbnail', (req, res) => {
    const t = dao.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    if (!thumb.saveThumbnail || !thumb.decodeImagePayload) {
      return res.status(500).json({ error: { code: 'THUMB_UNAVAILABLE', message: 'thumbnail storage not configured' } });
    }
    const buf = thumb.decodeImagePayload(req.body);
    if (!buf || buf.length < 32) {
      return res.status(400).json({
        error: { code: 'INVALID_THUMBNAIL', message: 'dataUrl or base64 JPEG required' },
      });
    }
    const thumbnailUrl = thumb.saveThumbnail(req.params.id, buf);
    res.json({ ok: true, thumbnailUrl });
  });

  router.post('/:id/regenerate-thumbnail', async (req, res) => {
    const t = dao.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    if (!thumb.regenerateThumbnail) {
      return res.status(500).json({ error: { code: 'THUMB_UNAVAILABLE', message: 'regenerate not configured' } });
    }
    try {
      const data = { ...t.data, id: t.id, name: t.name };
      const thumbnailUrl = await thumb.regenerateThumbnail(data);
      res.json({ ok: true, thumbnailUrl });
    } catch (e) {
      console.error('[thumbnail] regenerate failed', e);
      res.status(500).json({
        error: { code: 'THUMB_RENDER_FAILED', message: e.message || 'thumbnail render failed' },
      });
    }
  });

  router.put('/:id', (req, res) => {
    const { name, data, folderId, hiddenInControl } = req.body ?? {};
    if (data !== undefined) {
      const { valid, errors } = validateTemplate(data);
      if (!valid) {
        return res.status(422).json({ error: templateValidationErrorPayload(errors) });
      }
    }
    const updated = dao.update(req.params.id, {
      name,
      data,
      ...(folderId !== undefined ? { folderId: folderId || null } : {}),
      ...(hiddenInControl !== undefined ? { hiddenInControl: Boolean(hiddenInControl) } : {}),
    });
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json(withThumb(updated));
  });

  router.delete('/:id', (req, res) => {
    const ok = dao.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    if (deDao) deDao.removeByTemplateId(req.params.id);
    thumb.removeThumbnail?.(req.params.id);
    res.json({ ok: true });
  });

  return router;
}
