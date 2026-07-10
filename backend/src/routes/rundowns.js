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

function errorBody(code, message, details = null) {
  return { error: { code, message, details } };
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateSlots(slots) {
  if (!Array.isArray(slots)) {
    return 'slots must be an array';
  }
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (!isPlainObject(slot)) {
      return `slots[${i}] must be an object`;
    }
    if (typeof slot.templateId !== 'string' || !slot.templateId.trim()) {
      return `slots[${i}].templateId is required`;
    }
    if (slot.slotId !== undefined && (typeof slot.slotId !== 'string' || !slot.slotId.trim())) {
      return `slots[${i}].slotId must be a non-empty string`;
    }
    if (
      slot.dataElementId !== undefined
      && slot.dataElementId !== null
      && (typeof slot.dataElementId !== 'string' || !slot.dataElementId.trim())
    ) {
      return `slots[${i}].dataElementId must be a non-empty string or null`;
    }
  }
  return null;
}

export function rundownsRouter(db) {
  const dao = rundownsDao(db);
  const router = Router();

  router.get('/', (req, res) => {
    const channelId = typeof req.query.channelId === 'string' && req.query.channelId.trim()
      ? req.query.channelId.trim()
      : (typeof req.query.channel_id === 'string' && req.query.channel_id.trim()
        ? req.query.channel_id.trim()
        : undefined);
    res.json(dao.all(channelId ? { channelId } : {}));
  });

  // Reorder must be matched before "/:id" routes.
  router.post('/reorder', (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id.trim())) {
      return res.status(400).json(errorBody('IDS_ARRAY_REQUIRED', 'ids must be a non-empty string array'));
    }
    if (new Set(ids).size !== ids.length) {
      return res.status(400).json(errorBody('IDS_DUPLICATE', 'ids array must not contain duplicates'));
    }
    const channelId = typeof req.body?.channelId === 'string' && req.body.channelId.trim()
      ? req.body.channelId.trim()
      : (typeof req.body?.channel_id === 'string' && req.body.channel_id.trim()
        ? req.body.channel_id.trim()
        : undefined);
    const existing = dao.all(channelId ? { channelId } : {}).map((r) => r.id);
    if (existing.length !== ids.length) {
      return res.status(400).json(errorBody('IDS_INCOMPLETE', 'ids must contain the full rundown list for the scope'));
    }
    const existingSet = new Set(existing);
    if (ids.some((id) => !existingSet.has(id))) {
      return res.status(400).json(errorBody('IDS_UNKNOWN', 'ids contain unknown rundown id'));
    }
    res.json(dao.reorder(ids, channelId ? { channelId } : {}));
  });

  router.post('/', (req, res) => {
    const body = req.body ?? {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const slots = body.slots === undefined ? [] : body.slots;
    const slotsErr = validateSlots(slots);
    if (slotsErr) {
      return res.status(422).json(errorBody('SLOTS_INVALID', slotsErr));
    }
    const channelId = body.channel_id ?? body.channelId ?? null;
    if (channelId !== null && channelId !== undefined && typeof channelId !== 'string') {
      return res.status(422).json(errorBody('CHANNEL_ID_INVALID', 'channel_id/channelId must be string or null'));
    }

    const id = body.id || uuid();
    const fallbackName = `Rundown ${dao.count() + 1}`;
    const created = dao.create({
      id,
      name: name || fallbackName,
      channel_id: channelId,
      slots,
    });
    res.status(201).json(created);
  });

  router.get('/:id', (req, res) => {
    const rd = dao.get(req.params.id);
    if (!rd) return res.status(404).json(errorBody('RUNDOWN_NOT_FOUND', 'rundown not found'));
    res.json(rd);
  });

  router.put('/:id', (req, res) => {
    const body = req.body ?? {};
    if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) {
      return res.status(422).json(errorBody('NAME_INVALID', 'name must be a non-empty string'));
    }
    if (body.channel_id !== undefined && body.channel_id !== null && typeof body.channel_id !== 'string') {
      return res.status(422).json(errorBody('CHANNEL_ID_INVALID', 'channel_id must be string or null'));
    }
    if (body.channelId !== undefined && body.channelId !== null && typeof body.channelId !== 'string') {
      return res.status(422).json(errorBody('CHANNEL_ID_INVALID', 'channelId must be string or null'));
    }
    if (body.slots !== undefined) {
      const slotsErr = validateSlots(body.slots);
      if (slotsErr) {
        return res.status(422).json(errorBody('SLOTS_INVALID', slotsErr));
      }
    }
    const patch = {
      name: body.name,
      channel_id: body.channel_id ?? body.channelId,
      slots: body.slots,
    };
    const updated = dao.update(req.params.id, patch);
    if (!updated) return res.status(404).json(errorBody('RUNDOWN_NOT_FOUND', 'rundown not found'));
    res.json(updated);
  });

  router.delete('/:id', (req, res) => {
    const ok = dao.remove(req.params.id);
    if (!ok) return res.status(404).json(errorBody('RUNDOWN_NOT_FOUND', 'rundown not found'));
    res.json({ ok: true });
  });

  return router;
}
