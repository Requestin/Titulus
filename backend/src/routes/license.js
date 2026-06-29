import { Router } from 'express';
import { licenseDao } from '../db.js';

const LICENSE_KEY_RE = /^TIT-[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/;
const VALID_STATUS = new Set(['unlicensed', 'active', 'expired', 'invalid']);

function toPublicState(row) {
  const key = row.license_key || '';
  const masked = key.length >= 8
    ? `${key.slice(0, 4)}****${key.slice(-4)}`
    : '';
  return {
    status: row.status,
    plan: row.plan,
    holder: row.holder,
    hasKey: key.length > 0,
    keyMasked: masked,
    activatedAt: row.activated_at,
    expiresAt: row.expires_at,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error || null,
  };
}

function errorBody(code, message, details = null) {
  return { error: { code, message, details } };
}

export function licenseRouter(db) {
  const dao = licenseDao(db);
  const router = Router();

  router.get('/', (req, res) => {
    res.json(toPublicState(dao.get()));
  });

  // Phase 6 foundation: local activation contract.
  // External licensing provider integration is intentionally deferred.
  router.post('/activate', (req, res) => {
    const body = req.body ?? {};
    const licenseKey = typeof body.licenseKey === 'string'
      ? body.licenseKey.trim().toUpperCase()
      : '';
    const holder = typeof body.holder === 'string' ? body.holder.trim() : '';
    const plan = typeof body.plan === 'string' && body.plan.trim()
      ? body.plan.trim()
      : 'starter';

    if (!licenseKey) {
      return res.status(400).json(errorBody('LICENSE_KEY_REQUIRED', 'licenseKey is required'));
    }
    if (!LICENSE_KEY_RE.test(licenseKey)) {
      return res.status(422).json(errorBody(
        'LICENSE_KEY_FORMAT_INVALID',
        'licenseKey format is invalid',
        'expected TIT-XXXX-XXXX-XXXX-XXXX',
      ));
    }

    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const row = dao.activate({ licenseKey, holder, plan, expiresAt });
    return res.status(200).json(toPublicState(row));
  });

  router.post('/deactivate', (req, res) => {
    const row = dao.deactivate();
    res.json(toPublicState(row));
  });

  router.post('/check', (req, res) => {
    const body = req.body ?? {};
    const status = typeof body.status === 'string' ? body.status : '';
    const lastError = typeof body.lastError === 'string' ? body.lastError : '';
    if (status && !VALID_STATUS.has(status)) {
      return res.status(422).json(errorBody(
        'LICENSE_STATUS_INVALID',
        'status must be one of unlicensed|active|expired|invalid',
      ));
    }
    const current = dao.get();
    const nextStatus = status || current.status;
    const row = dao.markChecked({ status: nextStatus, error: lastError });
    res.json(toPublicState(row));
  });

  return router;
}
