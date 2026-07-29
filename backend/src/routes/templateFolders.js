// backend/src/routes/templateFolders.js
//
// REST for one-level template folders:
//   GET    /api/template-folders
//   POST   /api/template-folders
//   PUT    /api/template-folders/:id
//   DELETE /api/template-folders/:id
//     ?deleteTemplates=1  — also delete templates that belonged to the folder
//     (default)           — unfile templates (folder_id = NULL)

import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { templateFoldersDao, templatesDao } from '../db.js';
import { dataElementsDao } from '../dataElementsDb.js';

export function templateFoldersRouter(db, dataElementsDb = null) {
  const dao = templateFoldersDao(db);
  const tplDao = templatesDao(db);
  const deDao = dataElementsDb ? dataElementsDao(dataElementsDb) : null;
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(dao.all());
  });

  router.post('/', (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      return res.status(400).json({ error: { code: 'NAME_REQUIRED', message: 'name required' } });
    }
    const sortOrder = typeof req.body?.sortOrder === 'number' ? req.body.sortOrder : dao.all().length;
    const created = dao.create({ id: uuid(), name, sortOrder });
    res.status(201).json(created);
  });

  router.put('/:id', (req, res) => {
    const patch = {};
    if (req.body?.name !== undefined) {
      const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
      if (!name) {
        return res.status(400).json({ error: { code: 'NAME_INVALID', message: 'name must be non-empty' } });
      }
      patch.name = name;
    }
    if (req.body?.sortOrder !== undefined) {
      patch.sortOrder = Number(req.body.sortOrder) || 0;
    }
    const updated = dao.update(req.params.id, patch);
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json(updated);
  });

  router.delete('/:id', (req, res) => {
    const deleteTemplates =
      req.query.deleteTemplates === '1'
      || req.query.deleteTemplates === 'true'
      || req.body?.deleteTemplates === true;

    if (deleteTemplates) {
      const members = tplDao.all({ folderId: req.params.id });
      for (const t of members) {
        tplDao.remove(t.id);
        if (deDao) deDao.removeByTemplateId(t.id);
      }
    }

    const ok = dao.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, deletedTemplates: deleteTemplates });
  });

  return router;
}
