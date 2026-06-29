import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { authDao } from './db.js';

const ROLES = new Set(['operator', 'admin']);
const SESSION_TTL_HOURS = parseInt(process.env.TITULUS_SESSION_TTL_HOURS || '12', 10);

function hashPassword(password, saltHex) {
  return scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
}

function passwordMatches(password, row) {
  const left = hashPassword(password, row.password_salt);
  const right = Buffer.from(row.password_hash, 'hex');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function sessionExpiresAt() {
  return new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000).toISOString();
}

function parseBearerToken(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return '';
  return match[1].trim();
}

function authError(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

export function createAuth(db) {
  const dao = authDao(db);

  function resolveSession(token) {
    if (!token) return null;
    const row = dao.getSessionWithUser(token);
    if (!row) return null;
    if (row.revoked_at) return null;
    if (!row.is_active) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) return null;
    return row;
  }

  function requireAuth(req, res, next) {
    if (req.method === 'OPTIONS') return next();
    const token = parseBearerToken(req);
    if (!token) return authError(res, 401, 'AUTH_REQUIRED', 'authorization token required');

    const session = resolveSession(token);
    if (!session) return authError(res, 401, 'AUTH_INVALID', 'authorization token is invalid or expired');

    dao.touchSession(token);
    req.auth = {
      token,
      userId: session.user_id,
      tenantId: session.tenant_id,
      username: session.username,
      role: session.role,
    };
    return next();
  }

  function requireRole(...allowed) {
    const allowedSet = new Set(allowed);
    return (req, res, next) => {
      if (!req.auth) return authError(res, 401, 'AUTH_REQUIRED', 'authentication required');
      if (!allowedSet.has(req.auth.role)) {
        return authError(res, 403, 'FORBIDDEN', 'insufficient role');
      }
      return next();
    };
  }

  function authenticateToken(token) {
    const session = resolveSession(token);
    if (!session) return null;
    dao.touchSession(token);
    return {
      token,
      userId: session.user_id,
      tenantId: session.tenant_id,
      username: session.username,
      role: session.role,
    };
  }

  return {
    dao,
    requireAuth,
    requireRole,
    authenticateToken,
    passwordMatches,
    sessionExpiresAt,
    parseBearerToken,
  };
}

export function buildPasswordHash(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt).toString('hex');
  return { salt, hash };
}

export function isValidRole(role) {
  return ROLES.has(role);
}
