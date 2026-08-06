import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import {
  ALL_PERMISSIONS,
  ADMINISTRATORS_GROUP_NAME,
  buildPasswordHash,
  isValidPermission,
} from '../auth.js';

function authError(res, status, code, message, details) {
  const body = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  return res.status(status).json(body);
}

function toPublicUser(row, permissions) {
  if (!row) return null;
  const perms = permissions ?? [];
  return {
    id: row.id,
    tenantId: row.tenant_id,
    username: row.username,
    role: row.role,
    groupId: row.group_id ?? null,
    groupName: row.group_name ?? null,
    permissions: perms,
    isActive: !!row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPublicGroup(group) {
  if (!group) return null;
  return {
    id: group.id,
    name: group.name,
    isSystem: !!group.isSystem || !!group.is_system,
    permissions: Array.isArray(group.permissions) ? group.permissions : [],
    createdAt: group.created_at,
    updatedAt: group.updated_at,
  };
}

function normalizePermissions(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const p of input) {
    if (typeof p !== 'string' || !isValidPermission(p)) return null;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

export function authRouter(auth) {
  const router = Router();
  const { dao } = auth;
  const requireSettings = [auth.requireAuth, auth.requirePermission('settings')];

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
    const permissions = dao.getUserPermissions(row.id);
    return res.json({
      token,
      expiresAt,
      user: toPublicUser(user, permissions.length ? permissions : (
        user.role === 'admin' ? [...ALL_PERMISSIONS] : []
      )),
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
    const permissions = req.auth.permissions || dao.getUserPermissions(user.id);
    return res.json({
      user: toPublicUser(user, permissions),
      tenantId: req.auth.tenantId,
      role: req.auth.role,
      groupId: req.auth.groupId ?? user.group_id ?? null,
      groupName: req.auth.groupName ?? user.group_name ?? null,
      permissions,
    });
  });

  // ---- groups ----

  router.get('/groups', ...requireSettings, (req, res) => {
    res.json(dao.listGroups().map(toPublicGroup));
  });

  router.post('/groups', ...requireSettings, (req, res) => {
    req.auditEventType = 'auth.group.create';
    const body = req.body ?? {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return authError(res, 400, 'GROUP_NAME_REQUIRED', 'name is required');
    }
    if (name === ADMINISTRATORS_GROUP_NAME) {
      return authError(res, 422, 'GROUP_NAME_RESERVED', 'administrators is a reserved group name');
    }
    const permissions = normalizePermissions(body.permissions ?? []);
    if (permissions === null) {
      return authError(res, 422, 'PERMISSIONS_INVALID', 'permissions must be a subset of known permissions', {
        allowed: [...ALL_PERMISSIONS],
      });
    }
    try {
      const created = dao.createGroup({ name, permissions });
      return res.status(201).json(toPublicGroup(created));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'group create failed';
      if (/UNIQUE/i.test(message)) {
        return authError(res, 409, 'GROUP_NAME_CONFLICT', 'group name already exists');
      }
      throw err;
    }
  });

  router.put('/groups/:id', ...requireSettings, (req, res) => {
    req.auditEventType = 'auth.group.update';
    const existing = dao.getGroup(req.params.id);
    if (!existing) return authError(res, 404, 'GROUP_NOT_FOUND', 'group not found');

    const body = req.body ?? {};
    try {
      if (typeof body.name === 'string') {
        dao.updateGroup(existing.id, { name: body.name });
      }
      if (body.permissions !== undefined) {
        let permissions = normalizePermissions(body.permissions);
        if (permissions === null) {
          return authError(res, 422, 'PERMISSIONS_INVALID', 'permissions must be a subset of known permissions', {
            allowed: [...ALL_PERMISSIONS],
          });
        }
        if (existing.name === ADMINISTRATORS_GROUP_NAME) {
          // settings must always remain; other permissions may be cleared.
          if (!permissions.includes('settings')) {
            permissions = [...permissions, 'settings'];
          }
        }
        dao.setGroupPermissions(existing.id, permissions);
      }
      return res.json(toPublicGroup(dao.getGroup(existing.id)));
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (message === 'ADMINISTRATORS_IMMUTABLE' || message === 'ADMINISTRATORS_PERMISSIONS_IMMUTABLE') {
        return authError(res, 422, message, 'administrators group is immutable');
      }
      if (/UNIQUE/i.test(message)) {
        return authError(res, 409, 'GROUP_NAME_CONFLICT', 'group name already exists');
      }
      throw err;
    }
  });

  router.delete('/groups/:id', ...requireSettings, (req, res) => {
    req.auditEventType = 'auth.group.delete';
    try {
      const ok = dao.deleteGroup(req.params.id);
      if (!ok) return authError(res, 404, 'GROUP_NOT_FOUND', 'group not found');
      return res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (message === 'ADMINISTRATORS_IMMUTABLE') {
        return authError(res, 422, 'ADMINISTRATORS_IMMUTABLE', 'cannot delete administrators group');
      }
      if (message === 'GROUP_IN_USE') {
        return authError(res, 409, 'GROUP_IN_USE', 'group still has users assigned');
      }
      throw err;
    }
  });

  // ---- users ----

  router.get('/users', ...requireSettings, (req, res) => {
    const users = dao.listUsers().map((row) => {
      let permissions = dao.getUserPermissions(row.id);
      if ((!permissions || permissions.length === 0) && row.role === 'admin') {
        permissions = [...ALL_PERMISSIONS];
      }
      return toPublicUser(row, permissions);
    });
    res.json(users);
  });

  router.post('/users', ...requireSettings, (req, res) => {
    req.auditEventType = 'auth.user.create';
    const body = req.body ?? {};
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || !password) {
      return authError(res, 400, 'USER_FIELDS_REQUIRED', 'username and password are required');
    }

    let groupId = typeof body.groupId === 'string' ? body.groupId : undefined;
    if (groupId) {
      const group = dao.getGroup(groupId);
      if (!group) return authError(res, 422, 'GROUP_NOT_FOUND', 'group not found');
    } else if (typeof body.role === 'string' && body.role === 'admin') {
      const admins = dao.getGroupByName(ADMINISTRATORS_GROUP_NAME);
      groupId = admins?.id;
    }

    const { hash, salt } = buildPasswordHash(password);
    try {
      const created = dao.createUser({
        tenantId: req.auth.tenantId,
        username,
        passwordHash: hash,
        passwordSalt: salt,
        groupId,
      });
      const permissions = dao.getUserPermissions(created.id);
      return res.status(201).json(toPublicUser(created, permissions));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'user create failed';
      if (message === 'GROUP_NOT_FOUND') {
        return authError(res, 422, 'GROUP_NOT_FOUND', 'group not found');
      }
      if (/UNIQUE/i.test(message)) {
        return authError(res, 409, 'USERNAME_CONFLICT', 'username already exists');
      }
      throw err;
    }
  });

  router.put('/users/:id', ...requireSettings, (req, res) => {
    req.auditEventType = 'auth.user.update';
    const existing = dao.getUserById(req.params.id);
    if (!existing) return authError(res, 404, 'USER_NOT_FOUND', 'user not found');

    const body = req.body ?? {};
    const patch = { id: existing.id };

    if (typeof body.username === 'string') {
      const next = body.username.trim();
      if (!next) return authError(res, 400, 'USERNAME_REQUIRED', 'username cannot be empty');
      patch.username = next;
    }

    if (typeof body.password === 'string') {
      if (!body.password) {
        return authError(res, 400, 'PASSWORD_REQUIRED', 'password cannot be empty');
      }
      const { hash, salt } = buildPasswordHash(body.password);
      patch.passwordHash = hash;
      patch.passwordSalt = salt;
    }

    if (body.groupId !== undefined) {
      if (body.groupId === null || body.groupId === '') {
        return authError(res, 422, 'GROUP_REQUIRED', 'groupId is required');
      }
      if (typeof body.groupId !== 'string') {
        return authError(res, 422, 'GROUP_INVALID', 'groupId must be a string');
      }
      const group = dao.getGroup(body.groupId);
      if (!group) return authError(res, 422, 'GROUP_NOT_FOUND', 'group not found');

      const leavingAdmins = existing.group_name === ADMINISTRATORS_GROUP_NAME
        && group.name !== ADMINISTRATORS_GROUP_NAME;
      if (leavingAdmins && existing.is_active) {
        const remaining = dao.countActiveAdministrators({ excludeUserId: existing.id });
        if (remaining < 1) {
          return authError(
            res,
            422,
            'LAST_ADMIN',
            'cannot remove the last active administrator from administrators group',
          );
        }
      }
      patch.groupId = body.groupId;
    }

    if (body.isActive !== undefined) {
      const nextActive = !!body.isActive;
      if (!nextActive && existing.is_active && existing.group_name === ADMINISTRATORS_GROUP_NAME) {
        const remaining = dao.countActiveAdministrators({ excludeUserId: existing.id });
        if (remaining < 1) {
          return authError(res, 422, 'LAST_ADMIN', 'cannot deactivate the last active administrator');
        }
      }
      patch.isActive = nextActive;
    }

    try {
      const updated = dao.updateUser(patch);
      if (body.isActive === false || (body.isActive !== undefined && !body.isActive)) {
        dao.revokeSessionsByUser(existing.id);
      }
      const permissions = dao.getUserPermissions(updated.id);
      return res.json(toPublicUser(updated, permissions));
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (message === 'GROUP_NOT_FOUND') {
        return authError(res, 422, 'GROUP_NOT_FOUND', 'group not found');
      }
      if (/UNIQUE/i.test(message)) {
        return authError(res, 409, 'USERNAME_CONFLICT', 'username already exists');
      }
      throw err;
    }
  });

  return router;
}
