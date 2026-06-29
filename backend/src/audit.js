import { auditDao } from './db.js';

const SECRET_KEYS = new Set(['password', 'licenseKey', 'token', 'authorization']);
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function sanitizeValue(value, depth = 0) {
  if (depth > 3) return '[max-depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (value.length > 256) return `${value.slice(0, 256)}...[truncated]`;
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitizeValue(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.has(k)) {
        out[k] = '[redacted]';
      } else {
        out[k] = sanitizeValue(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

function inferEventType(req) {
  if (req.auditEventType && typeof req.auditEventType === 'string') return req.auditEventType;
  const fullPath = `${req.baseUrl || ''}${req.path || ''}`;
  const path = fullPath.replace(/^\/+/, '').replace(/[/:?&=]/g, '.').replace(/\.+/g, '.');
  return `http.${req.method.toLowerCase()}.${path || 'root'}`;
}

export function createAudit(db) {
  const dao = auditDao(db);

  function appendAudit(req, res, next) {
    const fullPath = `${req.baseUrl || ''}${req.path || ''}`;
    if (!fullPath.startsWith('/api/')) return next();
    if (!MUTATING_METHODS.has(req.method)) return next();
    if (fullPath === '/api/health') return next();

    const snapshot = sanitizeValue(req.auditDetails ?? req.body ?? {});
    res.on('finish', () => {
      try {
        dao.create({
          tenantId: req.auth?.tenantId ?? null,
          userId: req.auth?.userId ?? null,
          username: req.auth?.username ?? null,
          role: req.auth?.role ?? null,
          eventType: inferEventType(req),
          method: req.method,
          path: fullPath,
          status: res.statusCode,
          ip: req.ip || '',
          userAgent: req.headers['user-agent'] || '',
          details: snapshot,
        });
      } catch (err) {
        console.error('[audit] write failed', err);
      }
    });
    return next();
  }

  return { dao, appendAudit };
}
