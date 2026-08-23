import { Router } from 'express';
import { dataElementsDao } from '../operatorTables.js';
import { templatesDao } from '../db.js';

function apiError(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

export function dataElementsRouter(db) {
  const dao = dataElementsDao(db);
  const templates = templatesDao(db);
  const router = Router();

  router.get('/', (req, res) => res.json(dao.all()));

  router.post('/', (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const templateId = typeof req.body?.templateId === 'string' ? req.body.templateId : '';
    if (!name || !templateId) return apiError(res, 400, 'FIELDS_REQUIRED', 'name and templateId required');
    if (!templates.get(templateId)) return apiError(res, 404, 'TEMPLATE_NOT_FOUND', 'template not found');
    res.status(201).json(dao.create({ name, templateId, payload: req.body.payload ?? {} }));
  });

  router.get('/:id', (req, res) => {
    const row = dao.get(req.params.id);
    if (!row) return apiError(res, 404, 'NOT_FOUND', 'data element not found');
    res.json(row);
  });

  router.put('/:id', (req, res) => {
    const updated = dao.update(req.params.id, { name: req.body?.name, payload: req.body?.payload });
    if (!updated) return apiError(res, 404, 'NOT_FOUND', 'data element not found');
    res.json(updated);
  });

  router.delete('/:id', (req, res) => {
    if (!dao.remove(req.params.id)) return apiError(res, 404, 'NOT_FOUND', 'data element not found');
    res.json({ ok: true });
  });

  return router;
}
