import { Router } from 'express';
import { licenseDao } from '../db.js';

const PLAN_ENTITLEMENTS = {
  none: { maxChannels: 1, decklink: false, stream: false, users: 1 },
  starter: { maxChannels: 2, decklink: false, stream: true, users: 3 },
  pro: { maxChannels: 4, decklink: true, stream: true, users: 10 },
  enterprise: { maxChannels: 8, decklink: true, stream: true, users: 100 },
};

function eventError(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

function normalizePlan(plan) {
  const key = typeof plan === 'string' ? plan.trim().toLowerCase() : '';
  if (!key || !(key in PLAN_ENTITLEMENTS)) return 'starter';
  return key;
}

function toEntitlements(state) {
  const licensed = state.status === 'active';
  const plan = licensed ? normalizePlan(state.plan) : 'none';
  return {
    status: state.status,
    plan,
    holder: state.holder,
    expiresAt: state.expires_at,
    limits: PLAN_ENTITLEMENTS[plan],
  };
}

export function billingRouter(db, auth) {
  const router = Router();
  const licenses = licenseDao(db);

  router.get('/entitlements', auth.requireAuth, (req, res) => {
    req.auditEventType = 'billing.entitlements.read';
    const state = licenses.get();
    res.json(toEntitlements(state));
  });

  // Billing provider webhook hook (Phase 6.3). Uses static secret from env.
  router.post('/hook', (req, res) => {
    req.auditEventType = 'billing.hook.apply';
    const configuredSecret = process.env.TITULUS_BILLING_HOOK_SECRET || '';
    if (!configuredSecret) {
      return eventError(res, 503, 'BILLING_HOOK_DISABLED', 'billing hook secret is not configured');
    }
    const provided = req.headers['x-titulus-billing-secret'];
    if (typeof provided !== 'string' || provided !== configuredSecret) {
      return eventError(res, 401, 'BILLING_HOOK_UNAUTHORIZED', 'billing hook secret is invalid');
    }
    const body = req.body ?? {};
    const status = typeof body.status === 'string' ? body.status : 'active';
    const holder = typeof body.holder === 'string' ? body.holder.trim() : '';
    const plan = normalizePlan(body.plan);
    const licenseKey = typeof body.licenseKey === 'string' ? body.licenseKey.trim() : 'HOOK';
    const expiresAt = typeof body.expiresAt === 'string' ? body.expiresAt : null;
    const lastError = typeof body.lastError === 'string' ? body.lastError : '';

    if (status === 'active') {
      licenses.activate({
        licenseKey,
        holder,
        plan,
        expiresAt,
      });
      return res.json({ ok: true, entitlements: toEntitlements(licenses.get()) });
    }

    if (status === 'unlicensed') {
      licenses.deactivate();
      return res.json({ ok: true, entitlements: toEntitlements(licenses.get()) });
    }

    if (!['expired', 'invalid'].includes(status)) {
      return eventError(res, 422, 'BILLING_STATUS_INVALID', 'status must be active|unlicensed|expired|invalid');
    }

    licenses.markChecked({ status, error: lastError });
    return res.json({ ok: true, entitlements: toEntitlements(licenses.get()) });
  });

  return router;
}
