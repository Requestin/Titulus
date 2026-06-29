// backend/src/db.js
//
// SQLite (better-sqlite3, WAL mode) schema + DAOs for the Titulus control plane
// (DEVELOPMENT_PROMPT §7.2).
//
// Tables: templates, channels, rundowns, settings, on_air, license_state.
// On-air persistence (§NFR-1): the on_air table stores the full take command so
// a backend restart can replay the picture to every /ws/renderer client.

import Database from 'better-sqlite3';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** @typedef {import('better-sqlite3').Database} Database */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS templates (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  data       TEXT NOT NULL,            -- JSON Template
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS channels (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  output_mode  TEXT NOT NULL DEFAULT 'browser',  -- browser|obs_vmix|decklink|stream
  device_index INTEGER NOT NULL DEFAULT -1,      -- -1 = no DeckLink
  display_mode TEXT NOT NULL DEFAULT 'HD1080i50',
  keyer_mode   TEXT NOT NULL DEFAULT 'external', -- external|internal|fill_only
  stream_url   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rundowns (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  channel_id  TEXT,
  slots       TEXT NOT NULL DEFAULT '[]',        -- JSON array of slot objects
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- On-air state for replay-on-reconnect (§7.4, NFR-1). One row per (channel,
-- template) currently on air; command_json holds the full take message so the
-- backend can fan it out to renderers verbatim after a restart.
CREATE TABLE IF NOT EXISTS on_air (
  channel_id   TEXT NOT NULL,
  template_id  TEXT NOT NULL,
  command_json TEXT NOT NULL,
  order_index  INTEGER NOT NULL DEFAULT 0,
  taken_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel_id, template_id)
);

-- License activation state (Phase 6 foundation).
CREATE TABLE IF NOT EXISTS license_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  license_key     TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'unlicensed', -- unlicensed|active|expired|invalid
  plan            TEXT NOT NULL DEFAULT 'none',
  holder          TEXT NOT NULL DEFAULT '',
  activated_at    TEXT,
  expires_at      TEXT,
  last_checked_at TEXT,
  last_error      TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Multi-tenant auth baseline (Phase 6.2).
CREATE TABLE IF NOT EXISTS tenants (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'operator', -- operator|admin
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token         TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   TEXT,
  user_id     TEXT,
  username    TEXT,
  role        TEXT,
  event_type  TEXT NOT NULL,
  method      TEXT NOT NULL,
  path        TEXT NOT NULL,
  status      INTEGER NOT NULL,
  ip          TEXT NOT NULL DEFAULT '',
  user_agent  TEXT NOT NULL DEFAULT '',
  details     TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

/**
 * Open (and migrate) the database at the given path. Creates the parent dir.
 * @param {string} dbPath
 * @returns {Database}
 */
export function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  ensureOnAirOrderIndex(db);
  ensureLicenseRow(db);
  ensureAuthBootstrap(db);
  return db;
}

/** @param {Database} db */
function ensureOnAirOrderIndex(db) {
  const cols = db.prepare(`PRAGMA table_info(on_air)`).all();
  const hasOrderIndex = cols.some((c) => c.name === 'order_index');
  if (!hasOrderIndex) {
    db.exec(`ALTER TABLE on_air ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0`);
  }
}

/** @param {Database} db */
function ensureLicenseRow(db) {
  db.prepare(
    `INSERT INTO license_state (id) VALUES (1)
     ON CONFLICT(id) DO NOTHING`,
  ).run();
}

function hashPassword(password, saltHex) {
  return scryptSync(password, Buffer.from(saltHex, 'hex'), 64).toString('hex');
}

/** @param {Database} db */
function ensureAuthBootstrap(db) {
  const defaultTenantId = 'default';
  db.prepare(
    `INSERT INTO tenants (id, name) VALUES (?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(defaultTenantId, 'Default Tenant');

  const existingAdmin = db.prepare('SELECT id FROM users WHERE role = ? LIMIT 1').get('admin');
  if (!existingAdmin) {
    const username = (process.env.TITULUS_ADMIN_USER || 'admin').trim();
    const password = process.env.TITULUS_ADMIN_PASSWORD || 'admin123';
    const salt = randomBytes(16).toString('hex');
    const passwordHash = hashPassword(password, salt);
    db.prepare(
      `INSERT INTO users (id, tenant_id, username, password_hash, password_salt, role, is_active)
       VALUES (?, ?, ?, ?, ?, 'admin', 1)`,
    ).run(randomUUID(), defaultTenantId, username, passwordHash, salt);
  }
}

// ---------------------------------------------------------------------------
// templates
// ---------------------------------------------------------------------------

export const templatesDao = (db) => ({
  all() {
    return db.prepare('SELECT id, name, created_at, updated_at FROM templates ORDER BY updated_at DESC').all();
  },
  get(id) {
    const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(id);
    if (!row) return null;
    return { ...row, data: JSON.parse(row.data) };
  },
  create({ id, name, data }) {
    db.prepare(
      'INSERT INTO templates (id, name, data) VALUES (?, ?, ?)',
    ).run(id, name, JSON.stringify(data));
    return this.get(id);
  },
  update(id, { name, data }) {
    const cur = db.prepare('SELECT * FROM templates WHERE id = ?').get(id);
    if (!cur) return null;
    const next = {
      name: name ?? cur.name,
      data: data !== undefined ? JSON.stringify(data) : cur.data,
    };
    db.prepare(
      `UPDATE templates SET name = ?, data = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(next.name, next.data, id);
    return this.get(id);
  },
  remove(id) {
    return db.prepare('DELETE FROM templates WHERE id = ?').run(id).changes > 0;
  },
});

// ---------------------------------------------------------------------------
// channels
// ---------------------------------------------------------------------------

const MAX_CHANNELS = 8;

export const channelsDao = (db) => ({
  MAX: MAX_CHANNELS,
  all() {
    return db.prepare('SELECT * FROM channels ORDER BY created_at ASC').all();
  },
  get(id) {
    return db.prepare('SELECT * FROM channels WHERE id = ?').get(id) ?? null;
  },
  count() {
    return db.prepare('SELECT COUNT(*) AS n FROM channels').get().n;
  },
  create({ id, name, output_mode, device_index, display_mode, keyer_mode, stream_url }) {
    if (this.count() >= MAX_CHANNELS) {
      const err = new Error(`max ${MAX_CHANNELS} channels reached`);
      err.code = 'MAX_CHANNELS';
      throw err;
    }
    db.prepare(
      `INSERT INTO channels (id, name, output_mode, device_index, display_mode, keyer_mode, stream_url)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, name,
      output_mode ?? 'browser',
      device_index ?? -1,
      display_mode ?? 'HD1080i50',
      keyer_mode ?? 'external',
      stream_url ?? '',
    );
    return this.get(id);
  },
  update(id, patch) {
    const cur = this.get(id);
    if (!cur) return null;
    const next = {
      name: patch.name ?? cur.name,
      output_mode: patch.output_mode ?? cur.output_mode,
      device_index: patch.device_index ?? cur.device_index,
      display_mode: patch.display_mode ?? cur.display_mode,
      keyer_mode: patch.keyer_mode ?? cur.keyer_mode,
      stream_url: patch.stream_url ?? cur.stream_url,
    };
    db.prepare(
      `UPDATE channels SET name=?, output_mode=?, device_index=?, display_mode=?, keyer_mode=?, stream_url=? WHERE id=?`,
    ).run(next.name, next.output_mode, next.device_index, next.display_mode, next.keyer_mode, next.stream_url, id);
    return this.get(id);
  },
  remove(id) {
    return db.prepare('DELETE FROM channels WHERE id = ?').run(id).changes > 0;
  },
});

// ---------------------------------------------------------------------------
// rundowns
// ---------------------------------------------------------------------------

export const rundownsDao = (db) => ({
  all() {
    return db.prepare('SELECT * FROM rundowns ORDER BY sort_order ASC, created_at ASC').all()
      .map((r) => ({ ...r, slots: JSON.parse(r.slots) }));
  },
  get(id) {
    const r = db.prepare('SELECT * FROM rundowns WHERE id = ?').get(id);
    return r ? { ...r, slots: JSON.parse(r.slots) } : null;
  },
  create({ id, name, channel_id, slots }) {
    db.prepare(
      'INSERT INTO rundowns (id, name, channel_id, slots, sort_order) VALUES (?, ?, ?, ?, ?)',
    ).run(id, name, channel_id ?? null, JSON.stringify(slots ?? []), this.count());
    return this.get(id);
  },
  count() {
    return db.prepare('SELECT COUNT(*) AS n FROM rundowns').get().n;
  },
  update(id, patch) {
    const cur = this.get(id);
    if (!cur) return null;
    const next = {
      name: patch.name ?? cur.name,
      channel_id: patch.channel_id ?? cur.channel_id,
      slots: patch.slots !== undefined ? JSON.stringify(patch.slots) : JSON.stringify(cur.slots),
    };
    db.prepare(
      `UPDATE rundowns SET name=?, channel_id=?, slots=?, updated_at=datetime('now') WHERE id=?`,
    ).run(next.name, next.channel_id, next.slots, id);
    return this.get(id);
  },
  remove(id) {
    return db.prepare('DELETE FROM rundowns WHERE id = ?').run(id).changes > 0;
  },
  /** Reorder by an ordered list of ids (sets sort_order = index). */
  reorder(ids) {
    const tx = db.transaction((list) => {
      for (let i = 0; i < list.length; i++) {
        db.prepare('UPDATE rundowns SET sort_order = ? WHERE id = ?').run(i, list[i]);
      }
    });
    tx(ids);
    return this.all();
  },
});

// ---------------------------------------------------------------------------
// settings (key-value global fallback)
// ---------------------------------------------------------------------------

export const settingsDao = (db) => ({
  all() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },
  setAll(obj) {
    const tx = db.transaction((entries) => {
      const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      for (const [k, v] of entries) up.run(k, String(v));
    });
    tx(Object.entries(obj));
    return this.all();
  },
});

// ---------------------------------------------------------------------------
// license_state (phase 6 foundation)
// ---------------------------------------------------------------------------

export const licenseDao = (db) => ({
  get() {
    return db.prepare('SELECT * FROM license_state WHERE id = 1').get();
  },
  activate({ licenseKey, holder, plan, expiresAt }) {
    db.prepare(
      `UPDATE license_state
       SET license_key=?,
           status='active',
           holder=?,
           plan=?,
           activated_at=datetime('now'),
           expires_at=?,
           last_checked_at=datetime('now'),
           last_error='',
           updated_at=datetime('now')
       WHERE id=1`,
    ).run(licenseKey, holder ?? '', plan ?? 'starter', expiresAt ?? null);
    return this.get();
  },
  deactivate() {
    db.prepare(
      `UPDATE license_state
       SET license_key='',
           status='unlicensed',
           holder='',
           plan='none',
           activated_at=NULL,
           expires_at=NULL,
           last_checked_at=datetime('now'),
           last_error='',
           updated_at=datetime('now')
       WHERE id=1`,
    ).run();
    return this.get();
  },
  markChecked({ status, error }) {
    db.prepare(
      `UPDATE license_state
       SET status=?,
           last_checked_at=datetime('now'),
           last_error=?,
           updated_at=datetime('now')
       WHERE id=1`,
    ).run(status, error ?? '');
    return this.get();
  },
});

// ---------------------------------------------------------------------------
// auth (phase 6.2 baseline)
// ---------------------------------------------------------------------------

export const authDao = (db) => ({
  findUserByUsername(username) {
    return db.prepare(
      `SELECT u.id, u.tenant_id, u.username, u.password_hash, u.password_salt, u.role, u.is_active
       FROM users u
       WHERE u.username = ?`,
    ).get(username);
  },
  getUserById(id) {
    return db.prepare(
      `SELECT u.id, u.tenant_id, u.username, u.role, u.is_active, u.created_at, u.updated_at
       FROM users u
       WHERE u.id = ?`,
    ).get(id);
  },
  listUsers() {
    return db.prepare(
      `SELECT u.id, u.tenant_id, u.username, u.role, u.is_active, u.created_at, u.updated_at
       FROM users u
       ORDER BY u.created_at ASC`,
    ).all();
  },
  createUser({ tenantId, username, passwordHash, passwordSalt, role }) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO users (id, tenant_id, username, password_hash, password_salt, role, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    ).run(id, tenantId, username, passwordHash, passwordSalt, role);
    return this.getUserById(id);
  },
  setUserActive(id, isActive) {
    db.prepare(
      `UPDATE users
       SET is_active = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(isActive ? 1 : 0, id);
    return this.getUserById(id);
  },
  createSession({ token, userId, tenantId, expiresAt }) {
    db.prepare(
      `INSERT INTO sessions (token, user_id, tenant_id, expires_at)
       VALUES (?, ?, ?, ?)`,
    ).run(token, userId, tenantId, expiresAt);
  },
  getSessionWithUser(token) {
    return db.prepare(
      `SELECT s.token, s.user_id, s.tenant_id, s.expires_at, s.revoked_at,
              u.username, u.role, u.is_active
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`,
    ).get(token);
  },
  touchSession(token) {
    db.prepare(
      `UPDATE sessions
       SET last_seen_at = datetime('now')
       WHERE token = ?`,
    ).run(token);
  },
  revokeSession(token) {
    db.prepare(
      `UPDATE sessions
       SET revoked_at = datetime('now')
       WHERE token = ?`,
    ).run(token);
  },
  revokeSessionsByUser(userId) {
    db.prepare(
      `UPDATE sessions
       SET revoked_at = datetime('now')
       WHERE user_id = ? AND revoked_at IS NULL`,
    ).run(userId);
  },
});

// ---------------------------------------------------------------------------
// audit (phase 6.3 baseline)
// ---------------------------------------------------------------------------

export const auditDao = (db) => ({
  create({
    tenantId, userId, username, role, eventType, method, path, status, ip, userAgent, details,
  }) {
    db.prepare(
      `INSERT INTO audit_events
       (tenant_id, user_id, username, role, event_type, method, path, status, ip, user_agent, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      tenantId ?? null,
      userId ?? null,
      username ?? null,
      role ?? null,
      eventType,
      method,
      path,
      status,
      ip ?? '',
      userAgent ?? '',
      JSON.stringify(details ?? {}),
    );
  },
  list({ tenantId, limit = 100, eventType } = {}) {
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    const where = [];
    const args = [];
    if (tenantId) {
      where.push('tenant_id = ?');
      args.push(tenantId);
    }
    if (eventType) {
      where.push('event_type = ?');
      args.push(eventType);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return db.prepare(
      `SELECT id, tenant_id, user_id, username, role, event_type, method, path, status, ip, user_agent, details, created_at
       FROM audit_events
       ${whereSql}
       ORDER BY id DESC
       LIMIT ?`,
    ).all(...args, safeLimit).map((row) => {
      let parsed = {};
      try { parsed = JSON.parse(row.details); } catch { parsed = {}; }
      return {
        id: row.id,
        tenant_id: row.tenant_id,
        user_id: row.user_id,
        username: row.username,
        role: row.role,
        event_type: row.event_type,
        method: row.method,
        path: row.path,
        status: row.status,
        ip: row.ip,
        user_agent: row.user_agent,
        details: parsed,
        created_at: row.created_at,
      };
    });
  },
});

// ---------------------------------------------------------------------------
// on_air (persistence for replay-on-reconnect)
// ---------------------------------------------------------------------------

export const onAirDao = (db) => ({
  /** All current take commands, keyed by channelId -> array of command objects. */
  all() {
    const rows = db.prepare(
      `SELECT channel_id, template_id, command_json
       FROM on_air
       ORDER BY channel_id ASC, order_index ASC, taken_at ASC, template_id ASC`,
    ).all();
    const map = {};
    for (const r of rows) {
      if (!map[r.channel_id]) map[r.channel_id] = [];
      try {
        map[r.channel_id].push(JSON.parse(r.command_json));
      } catch {
        // Skip malformed persisted payloads instead of crashing backend startup.
      }
    }
    return map;
  },
  /** Commands for a single channel (for replay to a renderer that just connected). */
  forChannel(channelId) {
    const rows = db.prepare(
      `SELECT command_json
       FROM on_air
       WHERE channel_id = ?
       ORDER BY order_index ASC, taken_at ASC, template_id ASC`,
    ).all(channelId);
    const out = [];
    for (const r of rows) {
      try {
        out.push(JSON.parse(r.command_json));
      } catch {
        // Skip malformed row to keep reconnect flow alive.
      }
    }
    return out;
  },
  /** Single persisted command (or null) for channel/template key. */
  get(channelId, templateId) {
    const row = db.prepare(
      'SELECT command_json FROM on_air WHERE channel_id = ? AND template_id = ?',
    ).get(channelId, templateId);
    if (!row) return null;
    try {
      return JSON.parse(row.command_json);
    } catch {
      return null;
    }
  },
  /** Persist a take. */
  set(command, { bringToFront = true } = {}) {
    const existing = db.prepare(
      'SELECT order_index FROM on_air WHERE channel_id = ? AND template_id = ?',
    ).get(command.channelId, command.templateId);
    const max = db.prepare(
      'SELECT COALESCE(MAX(order_index), 0) AS n FROM on_air WHERE channel_id = ?',
    ).get(command.channelId).n;
    const orderIndex = bringToFront
      ? (max + 1)
      : (existing ? existing.order_index : (max + 1));
    db.prepare(
      `INSERT INTO on_air (channel_id, template_id, command_json, order_index)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(channel_id, template_id) DO UPDATE SET
         command_json = excluded.command_json,
         order_index = excluded.order_index,
         taken_at = datetime('now')`,
    ).run(command.channelId, command.templateId, JSON.stringify(command), orderIndex);
  },
  /** Remove a clear. */
  remove(channelId, templateId) {
    db.prepare('DELETE FROM on_air WHERE channel_id = ? AND template_id = ?').run(channelId, templateId);
  },
  /** Remove everything for a channel (CLEAR ALL). */
  clearChannel(channelId) {
    db.prepare('DELETE FROM on_air WHERE channel_id = ?').run(channelId);
  },
});
