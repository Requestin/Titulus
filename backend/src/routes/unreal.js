// backend/src/routes/unreal.js
//
// Unreal Remote Control proxy + pad invoke for render_backend=unreal channels.
// Docs: docs/unreal-vs-mode.md
//
// Unreal Web Remote Control (typical):
//   PUT {endpoint}/remote/object/call
//   PUT {endpoint}/remote/object/property

import { Router } from 'express';
import { channelsDao } from '../db.js';

const DEFAULT_TIMEOUT_MS = 5000;

function normalizeEndpoint(raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '');
  return s;
}

async function rcFetch(endpoint, path, body) {
  const url = `${endpoint}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { ok: res.ok, status: res.status, body: json };
  } finally {
    clearTimeout(timer);
  }
}

function actionToCallPayload(action) {
  const objectPath = action.rcObjectPath || action.objectPath || '';
  const functionName = action.rcFunctionName || action.functionName || '';
  const parameters = action.rcParameters || action.parameters || {};
  return {
    objectPath,
    functionName,
    parameters,
    generateTransaction: true,
  };
}

function actionToPropertyPayload(action) {
  return {
    objectPath: action.rcObjectPath || action.objectPath || '',
    access: 'WRITE_ACCESS',
    propertyName: action.rcPropertyPath || action.propertyPath || '',
    propertyValue: action.rcPropertyValue !== undefined
      ? action.rcPropertyValue
      : action.propertyValue,
  };
}

export function unrealRouter(db) {
  const dao = channelsDao(db);
  const router = Router();

  // List pad for channel
  router.get('/:channelId/actions', (req, res) => {
    const ch = dao.get(req.params.channelId);
    if (!ch) return res.status(404).json({ error: 'channel not found' });
    res.json({
      channelId: ch.id,
      render_backend: ch.render_backend,
      unreal_endpoint: ch.unreal_endpoint,
      actions: ch.unreal_pad ?? [],
    });
  });

  // Replace entire pad
  router.put('/:channelId/actions', (req, res) => {
    const ch = dao.get(req.params.channelId);
    if (!ch) return res.status(404).json({ error: 'channel not found' });
    const pad = req.body?.actions ?? req.body;
    if (!Array.isArray(pad)) {
      return res.status(400).json({ error: 'body.actions must be an array' });
    }
    const updated = dao.update(ch.id, { unreal_pad: pad });
    res.json({ channelId: updated.id, actions: updated.unreal_pad });
  });

  // Invoke a pad button via Unreal Remote Control
  router.post('/:channelId/actions/:actionId/invoke', async (req, res) => {
    const ch = dao.get(req.params.channelId);
    if (!ch) return res.status(404).json({ error: 'channel not found' });
    if (ch.render_backend !== 'unreal') {
      return res.status(400).json({
        error: 'channel render_backend is not unreal',
        code: 'NOT_UNREAL_BACKEND',
      });
    }
    const endpoint = normalizeEndpoint(ch.unreal_endpoint);
    if (!endpoint) {
      return res.status(400).json({ error: 'unreal_endpoint not configured', code: 'NO_ENDPOINT' });
    }
    const action = (ch.unreal_pad ?? []).find((a) => a && a.id === req.params.actionId);
    if (!action) return res.status(404).json({ error: 'action not found' });

    const dryRun = req.query.dryRun === '1' || req.body?.dryRun === true;
    const useProperty = Boolean(action.rcPropertyPath || action.propertyPath);
    const path = useProperty ? '/remote/object/property' : '/remote/object/call';
    const payload = useProperty ? actionToPropertyPayload(action) : actionToCallPayload(action);

    if (dryRun) {
      return res.json({ ok: true, dryRun: true, endpoint, path, payload });
    }

    try {
      const result = await rcFetch(endpoint, path, payload);
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
        actionId: action.id,
        label: action.label,
        endpoint,
        path,
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

  // Ad-hoc Remote Control call (operator / tooling)
  router.post('/:channelId/rc', async (req, res) => {
    const ch = dao.get(req.params.channelId);
    if (!ch) return res.status(404).json({ error: 'channel not found' });
    const endpoint = normalizeEndpoint(req.body?.endpoint || ch.unreal_endpoint);
    if (!endpoint) {
      return res.status(400).json({ error: 'unreal_endpoint required' });
    }
    const mode = req.body?.mode === 'property' ? 'property' : 'call';
    const path = mode === 'property' ? '/remote/object/property' : '/remote/object/call';
    const payload = req.body?.payload;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'payload object required' });
    }
    try {
      const result = await rcFetch(endpoint, path, payload);
      if (!result.ok) {
        return res.status(502).json({
          error: 'Unreal Remote Control call failed',
          code: 'UNREAL_RC_ERROR',
          status: result.status,
          details: result.body,
        });
      }
      return res.json({ ok: true, endpoint, path, result: result.body });
    } catch (e) {
      return res.status(502).json({
        error: e?.message || 'proxy failed',
        code: 'UNREAL_RC_PROXY',
      });
    }
  });

  return router;
}
