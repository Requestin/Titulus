// backend/src/routes/ueTemplates.js
//
// Unreal Blueprint template catalog (ZeroDensity-style forms).
// Separate from HTML /api/templates.

import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { ueTemplatesDao, channelsDao } from '../db.js';

function validateUeData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return ['data must be an object'];
  }
  const errs = [];
  if (data.rcObjectPath !== undefined && typeof data.rcObjectPath !== 'string') {
    errs.push('data.rcObjectPath must be a string');
  }
  if (data.actions !== undefined && !Array.isArray(data.actions)) {
    errs.push('data.actions must be an array');
  }
  if (Array.isArray(data.actions)) {
    for (let i = 0; i < data.actions.length; i++) {
      const a = data.actions[i];
      if (!a || typeof a !== 'object') {
        errs.push(`data.actions[${i}] must be an object`);
        continue;
      }
      if (typeof a.id !== 'string' || !a.id.trim()) errs.push(`data.actions[${i}].id required`);
      if (typeof a.label !== 'string' || !a.label.trim()) errs.push(`data.actions[${i}].label required`);
    }
  }
  return errs;
}

function defaultUeData() {
  return {
    schemaVersion: 1,
    description: '',
    // Default Remote Control object for take/clear (Blueprint path in UE).
    rcObjectPath: '',
    takeIn: { functionName: 'TakeIn', parameters: {} },
    takeOut: { functionName: 'TakeOut', parameters: {} },
    actions: [],
    variables: [],
  };
}

export function ueTemplatesRouter(db) {
  const dao = ueTemplatesDao(db);
  const channels = channelsDao(db);
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(dao.all());
  });

  router.post('/', (req, res) => {
    const body = req.body ?? {};
    if (!body.name || typeof body.name !== 'string') {
      return res.status(400).json({ error: 'name required' });
    }
    const data = body.data && typeof body.data === 'object' ? body.data : defaultUeData();
    const errs = validateUeData(data);
    if (errs.length) return res.status(400).json({ error: errs.join('; ') });
    const id = (typeof body.id === 'string' && body.id.trim()) ? body.id.trim() : uuid();
    const created = dao.create({ id, name: body.name.trim(), data: { ...defaultUeData(), ...data, id } });
    res.status(201).json(created);
  });

  router.get('/:id', (req, res) => {
    const t = dao.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    res.json(t);
  });

  router.put('/:id', (req, res) => {
    const body = req.body ?? {};
    if (body.data !== undefined) {
      const errs = validateUeData(body.data);
      if (errs.length) return res.status(400).json({ error: errs.join('; ') });
    }
    const updated = dao.update(req.params.id, {
      name: body.name,
      data: body.data,
    });
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json(updated);
  });

  router.delete('/:id', (req, res) => {
    const ok = dao.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  /**
   * TAKE / CLEAR a UE template against a channel's unreal_endpoint.
   * Body: { channelId, mode?: 'takeIn'|'takeOut'|'action', actionId?: string, dryRun?: boolean }
   */
  router.post('/:id/play', async (req, res) => {
    const tpl = dao.get(req.params.id);
    if (!tpl) return res.status(404).json({ error: 'ue template not found' });

    const channelId = req.body?.channelId;
    if (!channelId || typeof channelId !== 'string') {
      return res.status(400).json({ error: 'channelId required' });
    }
    const ch = channels.get(channelId);
    if (!ch) return res.status(404).json({ error: 'channel not found' });
    if (ch.render_backend !== 'unreal') {
      return res.status(400).json({
        error: 'channel render_backend must be unreal',
        code: 'NOT_UNREAL_CHANNEL',
      });
    }
    const endpoint = String(ch.unreal_endpoint || '').trim().replace(/\/+$/, '');
    const dryRun = req.query.dryRun === '1' || req.body?.dryRun === true;
    if (!endpoint && !dryRun) {
      return res.status(400).json({
        error: 'channel unreal_endpoint not configured',
        code: 'NO_ENDPOINT',
      });
    }

    const mode = req.body?.mode === 'takeOut' || req.body?.mode === 'action'
      ? req.body.mode
      : 'takeIn';
    const data = tpl.data ?? {};
    let functionName = '';
    let parameters = {};

    if (mode === 'takeIn') {
      functionName = data.takeIn?.functionName || 'TakeIn';
      parameters = data.takeIn?.parameters || {};
    } else if (mode === 'takeOut') {
      functionName = data.takeOut?.functionName || 'TakeOut';
      parameters = data.takeOut?.parameters || {};
    } else {
      const actionId = req.body?.actionId;
      const action = (data.actions || []).find((a) => a && a.id === actionId);
      if (!action) return res.status(404).json({ error: 'action not found on ue template' });
      functionName = action.rcFunctionName || action.functionName || '';
      parameters = action.rcParameters || action.parameters || {};
    }

    const payload = {
      objectPath: data.rcObjectPath || '',
      functionName,
      parameters,
      generateTransaction: true,
    };

    if (!payload.objectPath || !payload.functionName) {
      return res.status(400).json({
        error: 'ue template needs rcObjectPath and takeIn/takeOut functionName',
        code: 'UE_TEMPLATE_INCOMPLETE',
        payload,
      });
    }

    if (dryRun) {
      return res.json({
        ok: true,
        dryRun: true,
        endpoint: endpoint || null,
        path: '/remote/object/call',
        payload,
        mode,
      });
    }

    try {
      const url = `${endpoint}/remote/object/call`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      let result;
      try {
        const rcRes = await fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
        const text = await rcRes.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
        result = { ok: rcRes.ok, status: rcRes.status, body: json };
      } finally {
        clearTimeout(timer);
      }
      if (!result.ok) {
        return res.status(502).json({
          error: 'Unreal Remote Control call failed',
          code: 'UNREAL_RC_ERROR',
          status: result.status,
          details: result.body,
        });
      }
      return res.json({
        ok: true,
        mode,
        templateId: tpl.id,
        channelId,
        result: result.body,
      });
    } catch (e) {
      const aborted = e?.name === 'AbortError';
      return res.status(502).json({
        error: aborted ? 'Unreal Remote Control timeout' : (e?.message || 'proxy failed'),
        code: aborted ? 'UNREAL_RC_TIMEOUT' : 'UNREAL_RC_PROXY',
      });
    }
  });

  return router;
}
