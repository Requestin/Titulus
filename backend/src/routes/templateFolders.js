import { Router } from 'express';
import { templateFoldersDao } from '../operatorTables.js';

function apiError(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

export function templateFoldersRouter(db) {
  const dao = templateFoldersDao(db);
  const router = Router();

  router.get('/', (req, res) => res.json(dao.all()));

  router.post('/', (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) return apiError(res, 400, 'NAME_REQUIRED', 'name required');
    res.status(201).json(dao.create({ name, hideInControl: Boolean(req.body.hideInControl) }));
  });

  router.put('/:id', (req, res) => {
    const updated = dao.update(req.params.id, {
      name: typeof req.body?.name === 'string' ? req.body.name.trim() : undefined,
      hideInControl: req.body?.hideInControl,
    });
    if (!updated) return apiError(res, 404, 'NOT_FOUND', 'folder not found');
    res.json(updated);
  });

  router.delete('/:id', (req, res) => {
    const withTemplates = req.query.withTemplates === '1' || req.body?.withTemplates === true;
    if (!dao.remove(req.params.id, { withTemplates })) return apiError(res, 404, 'NOT_FOUND', 'folder not found');
    res.json({ ok: true, withTemplates });
  });

  router.post('/:id/assign', (req, res) => {
    const templateId = typeof req.body?.templateId === 'string' ? req.body.templateId : '';
    if (!templateId) return apiError(res, 400, 'TEMPLATE_REQUIRED', 'templateId required');
    if (!dao.setTemplateFolder(templateId, req.params.id)) return apiError(res, 404, 'NOT_FOUND', 'folder or template not found');
    res.json({ ok: true });
  });

  router.post('/unfile', (req, res) => {
    const templateId = typeof req.body?.templateId === 'string' ? req.body.templateId : '';
    if (!templateId) return apiError(res, 400, 'TEMPLATE_REQUIRED', 'templateId required');
    dao.setTemplateFolder(templateId, null);
    res.json({ ok: true });
  });

  return router;
}
