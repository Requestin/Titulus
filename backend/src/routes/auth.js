import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { buildPasswordHash, isValidRole } from '../auth.js';

function authError(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

function toPublicUser(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    username: row.username,
    role: row.role,
    isActive: !!row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function authRouter(auth) {
  const router = Router();
  const { dao } = auth;

  router.post('/login', (req, res) => {
    req.auditEventType = 'auth.login';
    const body = req.body ?? {};
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || !password) {
      return authError(res, 400, 'LOGIN_FIELDS_REQUIRED', 'username and password are required');
    }

    const row = dao.findUserByUsername(username);
    if (!row || !auth.passwordMatches(password, row) || !row.is_active) {
      return authError(res, 401, 'LOGIN_INVALID', 'invalid username or password');
    }

    const token = randomBytes(32).toString('hex');
    const expiresAt = auth.sessionExpiresAt();
    dao.createSession({
      token,
      userId: row.id,
      tenantId: row.tenant_id,
      expiresAt,
    });
    const user = dao.getUserById(row.id);
    return res.json({
      token,
      expiresAt,
      user: toPublicUser(user),
    });
  });

  router.post('/logout', auth.requireAuth, (req, res) => {
    req.auditEventType = 'auth.logout';
    dao.revokeSession(req.auth.token);
    res.json({ ok: true });
  });

  router.get('/me', auth.requireAuth, (req, res) => {
    const user = dao.getUserById(req.auth.userId);
    if (!user || !user.is_active) {
      return authError(res, 401, 'AUTH_INVALID', 'user is inactive');
    }
    return res.json({
      user: toPublicUser(user),
      tenantId: req.auth.tenantId,
      role: req.auth.role,
    });
  });

  router.get('/users', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
    res.json(dao.listUsers().map(toPublicUser));
  });

  router.post('/users', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
    req.auditEventType = 'auth.user.create';
    const body = req.body ?? {};
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const role = typeof body.role === 'string' ? body.role : 'operator';
    if (!username || !password) {
      return authError(res, 400, 'USER_FIELDS_REQUIRED', 'username and password are required');
    }
    if (!isValidRole(role)) {
      return authError(res, 422, 'ROLE_INVALID', 'role must be one of operator|admin');
    }
    const { hash, salt } = buildPasswordHash(password);
    try {
      const created = dao.createUser({
        tenantId: req.auth.tenantId,
        username,
        passwordHash: hash,
        passwordSalt: salt,
        role,
      });
      return res.status(201).json(toPublicUser(created));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'user create failed';
      if (/UNIQUE/i.test(message)) {
        return authError(res, 409, 'USERNAME_CONFLICT', 'username already exists');
      }
      throw err;
    }
  });

  return router;
}
