// backend/src/routes/templates.js
//
// REST API for templates (DEVELOPMENT_PROMPT §7.3):
//   GET    /api/templates            list (id/name/timestamps)
//   POST   /api/templates            create (validates against schema)
//   GET    /api/templates/:id        full template (with data)
//   PUT    /api/templates/:id        update
//   DELETE /api/templates/:id        delete
//   GET    /api/templates/schema      the JSON Schema
//   POST   /api/templates/validate    validate a body, return 200 {valid:true}
//                                     or 422 {valid:false,error:{code,message,details}}

import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { migrateTemplate, TemplateMigrationError } from '../templateMigration.js';
import { validateTemplate, schema, templateValidationErrorPayload } from '../templateValidation.js';
import { prepareTemplate } from '../prepareTemplate.js';
import { templateLocksDao } from '../operatorTables.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function templateMigrationErrorPayload(error) {
  return {
    code: error.code,
    message: error.message,
    details: error.details ?? {},
  };
}

function canonicalizeTemplate(value, res, { validationResponse = false } = {}) {
  try {
    return { ok: true, data: migrateTemplate(value) };
  } catch (error) {
    if (!(error instanceof TemplateMigrationError)) throw error;
    const body = { error: templateMigrationErrorPayload(error) };
    if (validationResponse) body.valid = false;
    res.status(422).json(body);
    return { ok: false, data: undefined };
  }
}

export function templatesRouter(db, options = {}) {
  const dao = templatesRouterDao(db);
  const router = Router();
  const dataDir = options.dataDir;
  const locks = templateLocksDao(db);

  router.get('/', (req, res) => {
    res.json(dao.all());
  });

  router.post('/', (req, res) => {
    const { name, data } = req.body ?? {};
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: { code: 'NAME_REQUIRED', message: 'name required' } });
    }
    if (!data || typeof data !== 'object') {
      return res.status(400).json({
        error: { code: 'TEMPLATE_DATA_REQUIRED', message: 'data (Template object) required' },
      });
    }
    const canonical = canonicalizeTemplate(data, res);
    if (!canonical.ok) return undefined;
    const { valid, errors } = validateTemplate(canonical.data);
    if (!valid) {
      return res.status(422).json({ error: templateValidationErrorPayload(errors) });
    }
    const id = canonical.data.id || uuid();
    const created = dao.create({ id, name, data: canonical.data });
    res.status(201).json(created);
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
    const canonical = canonicalizeTemplate(req.body, res, { validationResponse: true });
    if (!canonical.ok) return undefined;
    const { valid, errors } = validateTemplate(canonical.data);
    if (valid) {
      return res.status(200).json({ valid: true, errors: [] });
    }
    return res.status(422).json({
      valid: false,
      error: templateValidationErrorPayload(errors),
    });
  });


  router.post('/prepare', async (req, res) => {
    const body = req.body ?? {};
    let template = body.template;
    if (!template && typeof body.templateId === 'string') {
      const row = dao.get(body.templateId);
      if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'template not found' } });
      template = row.data;
    }
    if (!template || typeof template !== 'object') {
      return res.status(400).json({ error: { code: 'TEMPLATE_REQUIRED', message: 'template or templateId required' } });
    }
    const trigger = ['take', 'load', 'update', 'refresh'].includes(body.trigger) ? body.trigger : 'take';
    const result = await prepareTemplate(template, {
      trigger,
      variables: body.variables,
      dataDir,
      db,
      env: process.env,
    });
    return res.json(result);
  });


  router.get('/:id/lock', (req, res) => {
    const lock = locks.get(req.params.id);
    res.json({ lock: lock && locks.isFresh(lock) ? lock : null });
  });

  router.post('/:id/lock', (req, res) => {
    if (!dao.get(req.params.id)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'not found' } });
    const result = locks.acquire({
      templateId: req.params.id,
      userId: req.auth.userId,
      username: req.auth.username,
      token: req.auth.token,
    });
    if (!result.ok) return res.status(409).json({ error: { code: 'LOCKED', message: 'template is locked' }, lock: result.lock });
    res.json({ lock: result.lock });
  });

  router.post('/:id/heartbeat', (req, res) => {
    const lock = locks.heartbeat({ templateId: req.params.id, token: req.auth.token });
    if (!lock) return res.status(409).json({ error: { code: 'LOCK_LOST', message: 'lock is not owned or is stale' } });
    res.json({ lock });
  });

  router.post('/:id/unlock', (req, res) => {
    const ok = locks.release({ templateId: req.params.id, token: req.auth.token });
    if (!ok) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'not lock owner' } });
    res.json({ ok: true });
  });

  router.put('/:id/thumbnail', (req, res) => {
    const id = req.params.id;
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(id)) {
      return res.status(400).json({ error: { code: 'INVALID_ID', message: 'unsafe id' } });
    }
    if (!dao.get(id)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'not found' } });
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
        return res.status(415).json({ error: { code: 'UNSUPPORTED_FORMAT', message: 'JPEG required' } });
      }
      const dir = resolve(dataDir, 'thumbnails');
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, `${id}.jpg`), buffer);
      res.json({ url: `/thumbnails/${id}.jpg` });
    });
  });

  router.get('/:id', (req, res) => {
    const t = dao.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    const canonical = canonicalizeTemplate(t.data, res);
    if (!canonical.ok) return undefined;
    res.json({ ...t, data: canonical.data });
  });

  router.put('/:id', (req, res) => {
    const owner = locks.ownerToken(req.params.id);
    if (owner && owner !== req.auth?.token) {
      return res.status(409).json({ error: { code: 'LOCKED', message: 'template is locked by another user' } });
    }
    const { name, data, folder_id } = req.body ?? {};
    let canonicalData = data;
    if (data !== undefined) {
      const canonical = canonicalizeTemplate(data, res);
      if (!canonical.ok) return undefined;
      canonicalData = canonical.data;
      const { valid, errors } = validateTemplate(canonicalData);
      if (!valid) {
        return res.status(422).json({ error: templateValidationErrorPayload(errors) });
      }
    }
    const updated = dao.update(req.params.id, { name, data: canonicalData, folder_id });
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json(updated);
  });

  router.delete('/:id', (req, res) => {
    const ok = dao.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  return router;
}

// Local import to avoid a circular top-level dep: db.js exports the DAO factory.
import { templatesDao as templatesRouterDao } from '../db.js';
