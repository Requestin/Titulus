// backend/src/routes/rundowns.js
//
// REST API for rundowns (DEVELOPMENT_PROMPT §7.3):
//   GET    /api/rundowns             list (with slots parsed)
//   POST   /api/rundowns             create
//   PUT    /api/rundowns/:id         update (name/channel_id/slots)
//   DELETE /api/rundowns/:id         delete
//   POST   /api/rundowns/reorder     { ids: [id,...] } -> reordered list

import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { rundownsDao } from '../db.js';

export function rundownsRouter(db) {
  const dao = rundownsDao(db);
  const router = Router();

  router.get('/', (req, res) => {
    res.json(dao.all());
  });

  router.post('/', (req, res) => {
    const body = req.body ?? {};
    if (!body.name || typeof body.name !== 'string') {
      return res.status(400).json({ error: 'name required' });
    }
    const id = body.id || uuid();
    const created = dao.create({
      id, name: body.name,
      channel_id: body.channel_id ?? null,
      slots: Array.isArray(body.slots) ? body.slots : [],
    });
    res.status(201).json(created);
  });

  router.put('/:id', (req, res) => {
    const body = req.body ?? {};
    if (body.slots !== undefined && !Array.isArray(body.slots)) {
      return res.status(400).json({ error: 'slots must be an array' });
    }
    const updated = dao.update(req.params.id, body);
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json(updated);
  });

  router.delete('/:id', (req, res) => {
    const ok = dao.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  // Reorder must be matched before "/:id".
  router.post('/reorder', (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids)) {
      return res.status(400).json({ error: 'ids (array) required' });
    }
    res.json(dao.reorder(ids));
  });

  return router;
}
