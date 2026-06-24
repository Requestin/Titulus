// backend/src/routes/channels.js
//
// REST API for channels (DEVELOPMENT_PROMPT §7.3, REQ-11):
//   GET    /api/channels        list
//   POST   /api/channels        create (max 8 enforced by the DAO)
//   GET    /api/channels/:id    get
//   PUT    /api/channels/:id    update (output_mode/device/display_mode/keyer/stream_url)
//   DELETE /api/channels/:id    delete

import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { channelsDao } from '../db.js';

const VALID_OUTPUT_MODES = new Set(['browser', 'obs_vmix', 'decklink', 'stream']);
const VALID_KEYER_MODES = new Set(['external', 'internal', 'fill_only']);

function validateChannelBody(body, { partial = false } = {}) {
  const errs = [];
  if (!partial || body.output_mode !== undefined) {
    if (body.output_mode !== undefined && !VALID_OUTPUT_MODES.has(body.output_mode)) {
      errs.push(`output_mode must be one of browser|obs_vmix|decklink|stream`);
    }
  }
  if (!partial || body.keyer_mode !== undefined) {
    if (body.keyer_mode !== undefined && !VALID_KEYER_MODES.has(body.keyer_mode)) {
      errs.push(`keyer_mode must be one of external|internal|fill_only`);
    }
  }
  if (body.device_index !== undefined && !Number.isInteger(body.device_index)) {
    errs.push('device_index must be an integer (-1 = none)');
  }
  return errs;
}

export function channelsRouter(db) {
  const dao = channelsDao(db);
  const router = Router();

  router.get('/', (req, res) => {
    res.json(dao.all());
  });

  router.post('/', (req, res) => {
    const body = req.body ?? {};
    if (!body.name || typeof body.name !== 'string') {
      return res.status(400).json({ error: 'name required' });
    }
    const errs = validateChannelBody(body);
    if (errs.length) return res.status(400).json({ error: errs.join('; ') });
    try {
      const id = body.id || uuid();
      const created = dao.create({
        id, name: body.name,
        output_mode: body.output_mode,
        device_index: body.device_index,
        display_mode: body.display_mode,
        keyer_mode: body.keyer_mode,
        stream_url: body.stream_url,
      });
      res.status(201).json(created);
    } catch (e) {
      if (e.code === 'MAX_CHANNELS') return res.status(409).json({ error: e.message });
      throw e;
    }
  });

  router.get('/:id', (req, res) => {
    const c = dao.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json(c);
  });

  router.put('/:id', (req, res) => {
    const body = req.body ?? {};
    const errs = validateChannelBody(body, { partial: true });
    if (errs.length) return res.status(400).json({ error: errs.join('; ') });
    const updated = dao.update(req.params.id, body);
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
