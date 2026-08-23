import { randomUUID } from 'node:crypto';

export const STALE_LOCK_MS = 90 * 1000;
export const PERMISSIONS = ['template_editor', 'control', 'settings', 'files.read'];

export function templateFoldersDao(db) {
  return {
    all() {
      return db.prepare('SELECT * FROM template_folders ORDER BY sort_order ASC, name ASC').all();
    },
    get(id) {
      return db.prepare('SELECT * FROM template_folders WHERE id = ?').get(id) ?? null;
    },
    create({ name, hideInControl = false }) {
      const id = randomUUID();
      const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS n FROM template_folders').get().n;
      db.prepare(
        `INSERT INTO template_folders (id, name, hide_in_control, sort_order) VALUES (?, ?, ?, ?)`,
      ).run(id, name, hideInControl ? 1 : 0, max + 1);
      return this.get(id);
    },
    update(id, { name, hideInControl }) {
      const cur = this.get(id);
      if (!cur) return null;
      db.prepare(
        `UPDATE template_folders SET name = ?, hide_in_control = ? WHERE id = ?`,
      ).run(name ?? cur.name, hideInControl == null ? cur.hide_in_control : (hideInControl ? 1 : 0), id);
      return this.get(id);
    },
    remove(id, { withTemplates = false } = {}) {
      if (withTemplates) {
        db.prepare('DELETE FROM templates WHERE folder_id = ?').run(id);
      } else {
        db.prepare('UPDATE templates SET folder_id = NULL WHERE folder_id = ?').run(id);
      }
      return db.prepare('DELETE FROM template_folders WHERE id = ?').run(id).changes > 0;
    },
    setTemplateFolder(templateId, folderId) {
      if (folderId && !this.get(folderId)) return null;
      const result = db.prepare('UPDATE templates SET folder_id = ? WHERE id = ?').run(folderId, templateId);
      return result.changes > 0;
    },
  };
}

export function dataElementsDao(db) {
  return {
    all() {
      return db.prepare('SELECT * FROM data_elements ORDER BY updated_at DESC').all().map(parseDe);
    },
    get(id) {
      const row = db.prepare('SELECT * FROM data_elements WHERE id = ?').get(id);
      return row ? parseDe(row) : null;
    },
    create({ name, templateId, payload = {} }) {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO data_elements (id, name, template_id, payload) VALUES (?, ?, ?, ?)`,
      ).run(id, name, templateId, JSON.stringify(payload ?? {}));
      return this.get(id);
    },
    update(id, { name, payload }) {
      const cur = this.get(id);
      if (!cur) return null;
      db.prepare(
        `UPDATE data_elements SET name = ?, payload = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(name ?? cur.name, JSON.stringify(payload ?? cur.payload), id);
      return this.get(id);
    },
    remove(id) {
      return db.prepare('DELETE FROM data_elements WHERE id = ?').run(id).changes > 0;
    },
  };
}

function parseDe(row) {
  let payload = {};
  try { payload = JSON.parse(row.payload); } catch { payload = {}; }
  return {
    id: row.id,
    name: row.name,
    templateId: row.template_id,
    payload,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function templateLocksDao(db) {
  return {
    get(templateId) {
      return db.prepare('SELECT * FROM template_locks WHERE template_id = ?').get(templateId) ?? null;
    },
    isFresh(row, now = Date.now()) {
      if (!row) return false;
      const raw = String(row.heartbeat_at || "");
      const parsed = Date.parse(/Z|[+-]\d\d:\d\d$/.test(raw) ? raw : `${raw.replace(" ", "T")}Z`);
      if (!Number.isFinite(parsed)) return false;
      return now - parsed <= STALE_LOCK_MS;
    },
    acquire({ templateId, userId, username, token, now = Date.now() }) {
      const current = this.get(templateId);
      if (current && this.isFresh(current, now) && current.token !== token) {
        return { ok: false, lock: current };
      }
      db.prepare(`
        INSERT INTO template_locks (template_id, user_id, username, token, acquired_at, heartbeat_at)
        VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(template_id) DO UPDATE SET
          user_id = excluded.user_id,
          username = excluded.username,
          token = excluded.token,
          acquired_at = excluded.acquired_at,
          heartbeat_at = excluded.heartbeat_at
      `).run(templateId, userId, username, token);
      return { ok: true, lock: this.get(templateId) };
    },
    heartbeat({ templateId, token }) {
      const current = this.get(templateId);
      if (!current || current.token !== token || !this.isFresh(current)) return null;
      db.prepare(`UPDATE template_locks SET heartbeat_at = datetime('now') WHERE template_id = ?`).run(templateId);
      return this.get(templateId);
    },
    release({ templateId, token }) {
      const current = this.get(templateId);
      if (!current) return true;
      if (current.token !== token) return false;
      db.prepare('DELETE FROM template_locks WHERE template_id = ?').run(templateId);
      return true;
    },
    ownerToken(templateId) {
      const current = this.get(templateId);
      return this.isFresh(current) ? current.token : null;
    },
  };
}

export function rbacDao(db) {
  return {
    permissionsForUser(userId, role) {
      if (role === 'admin') return [...PERMISSIONS];
      return db.prepare(
        'SELECT group_id FROM user_group_members WHERE user_id = ? ORDER BY group_id',
      ).all(userId).map((row) => row.group_id);
    },
    hasPermission(userId, role, permission) {
      if (role === 'admin') return true;
      const row = db.prepare(
        'SELECT 1 FROM user_group_members WHERE user_id = ? AND group_id = ?',
      ).get(userId, permission);
      return Boolean(row);
    },
    assignDefaults(userId, role) {
      const groups = role === 'admin' ? PERMISSIONS : ['control', 'files.read'];
      const insert = db.prepare('INSERT OR IGNORE INTO user_group_members (user_id, group_id) VALUES (?, ?)');
      for (const group of groups) insert.run(userId, group);
    },
    listGroups() {
      return db.prepare('SELECT id FROM permission_groups ORDER BY id').all().map((row) => row.id);
    },
    setGroups(userId, groups) {
      db.prepare('DELETE FROM user_group_members WHERE user_id = ?').run(userId);
      const insert = db.prepare('INSERT OR IGNORE INTO user_group_members (user_id, group_id) VALUES (?, ?)');
      for (const group of groups) {
        if (PERMISSIONS.includes(group)) insert.run(userId, group);
      }
      return this.permissionsForUser(userId, 'operator');
    },
  };
}
