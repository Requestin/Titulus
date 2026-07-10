// backend/src/routes/dataElements.js
//
// REST API for DataElements (separate SQLite app.db-dataelements):
//   GET    /api/data-elements           list (?sort=updated|name)
//   GET    /api/data-elements/:id       one
//   POST   /api/data-elements           create
//   PUT    /api/data-elements/:id       update
//   DELETE /api/data-elements/:id       delete

import { Router } from 'express';
import { dataElementsDao } from '../dataElementsDb.js';

function errorBody(code, message, details = null) {
  return { error: { code, message, details } };
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function dataElementsRouter(deDb) {
  const dao = dataElementsDao(deDb);
  const router = Router();

  router.get('/', (req, res) => {
    const sort = req.query.sort === 'name' ? 'name' : 'updated';
    res.json(dao.all({ sort }));
  });

  router.post('/', (req, res) => {
    const body = req.body ?? {};
    const templateId = typeof body.templateId === 'string' ? body.templateId.trim() : '';
    if (!templateId) {
      return res.status(422).json(errorBody('TEMPLATE_ID_REQUIRED', 'templateId is required'));
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return res.status(422).json(errorBody('NAME_REQUIRED', 'name is required'));
    }
    if (body.vars !== undefined && !isPlainObject(body.vars)) {
      return res.status(422).json(errorBody('VARS_INVALID', 'vars must be an object'));
    }
    const username = req.auth?.username || 'unknown';
    const created = dao.create({
      templateId,
      name,
      vars: body.vars ?? {},
      createdBy: username,
      updatedBy: username,
    });
    res.status(201).json(created);
  });

  router.get('/:id', (req, res) => {
    const row = dao.get(req.params.id);
    if (!row) return res.status(404).json(errorBody('DATA_ELEMENT_NOT_FOUND', 'data element not found'));
    res.json(row);
  });

  router.put('/:id', (req, res) => {
    const body = req.body ?? {};
    if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) {
      return res.status(422).json(errorBody('NAME_INVALID', 'name must be a non-empty string'));
    }
    if (body.vars !== undefined && !isPlainObject(body.vars)) {
      return res.status(422).json(errorBody('VARS_INVALID', 'vars must be an object'));
    }
    const username = req.auth?.username || 'unknown';
    const updated = dao.update(req.params.id, {
      name: body.name,
      vars: body.vars,
      updatedBy: username,
    });
    if (!updated) return res.status(404).json(errorBody('DATA_ELEMENT_NOT_FOUND', 'data element not found'));
    res.json(updated);
  });

  router.delete('/:id', (req, res) => {
    const ok = dao.remove(req.params.id);
    if (!ok) return res.status(404).json(errorBody('DATA_ELEMENT_NOT_FOUND', 'data element not found'));
    res.json({ ok: true });
  });

  return router;
}
