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
  folder_id  TEXT,                     -- nullable; NULL = unfiled (All / unassigned)
  hidden_in_control INTEGER NOT NULL DEFAULT 0, -- 1 = hidden from Control pickers
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS template_folders (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  hidden_in_control INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Unreal / ZeroDensity-style template catalog (Blueprint forms), separate from HTML templates.
CREATE TABLE IF NOT EXISTS ue_templates (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  data       TEXT NOT NULL,            -- JSON UeTemplateData
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
  render_backend TEXT NOT NULL DEFAULT 'html',  -- html|unreal
  unreal_endpoint TEXT NOT NULL DEFAULT '',
  unreal_ndi_source TEXT NOT NULL DEFAULT '',
  vs_input_device INTEGER NOT NULL DEFAULT -1,
  vs_bg_file   TEXT NOT NULL DEFAULT '',
  vs_cam_file  TEXT NOT NULL DEFAULT '',
  unreal_pad   TEXT NOT NULL DEFAULT '[]',      -- JSON UnrealAction[]
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
  role          TEXT NOT NULL DEFAULT 'operator', -- operator|admin (derived from group)
  group_id      TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auth_groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  is_system  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auth_group_permissions (
  group_id   TEXT NOT NULL REFERENCES auth_groups(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (group_id, permission)
);

CREATE TABLE IF NOT EXISTS template_locks (
  template_id  TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  username     TEXT NOT NULL,
  locked_at    TEXT NOT NULL DEFAULT (datetime('now')),
  heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))
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

CREATE TABLE IF NOT EXISTS media_tags (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS media_assets (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  filename        TEXT NOT NULL,
  relative_path   TEXT NOT NULL UNIQUE,
  poster_path     TEXT,
  format          TEXT NOT NULL DEFAULT '',
  width           INTEGER NOT NULL DEFAULT 0,
  height          INTEGER NOT NULL DEFAULT 0,
  has_alpha       INTEGER NOT NULL DEFAULT 0,
  duration_sec    REAL,
  duration_frames INTEGER,
  fps             REAL,
  locked          INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'ready',
  source_relative_path TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS media_asset_tags (
  asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  tag_id   TEXT NOT NULL REFERENCES media_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (asset_id, tag_id)
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
  ensureMediaAssetColumns(db);
  ensureChannelVsColumns(db);
  ensureUeTemplatesTable(db);
  ensureTemplateFolders(db);
  ensureLicenseRow(db);
  ensureAuthBootstrap(db);
  ensureAuthGroupsBootstrap(db);
  return db;
}

/** Permission string constants mirrored in auth.js (ALL_PERMISSIONS). */
const BOOTSTRAP_ALL_PERMISSIONS = [
  'template_editor',
  'template_ue_editor',
  'control',
  'settings',
];
const ADMINISTRATORS_GROUP_NAME = 'administrators';
const OPERATORS_GROUP_NAME = 'operators';
const LOCK_STALE_SECONDS = 90;

/** @param {Database} db */
function ensureTemplateFolders(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS template_folders (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      hidden_in_control INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const cols = db.prepare('PRAGMA table_info(templates)').all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('folder_id')) {
    db.exec('ALTER TABLE templates ADD COLUMN folder_id TEXT');
  }
  // Legacy per-template flag (unused; visibility is folder-scoped).
  if (!names.has('hidden_in_control')) {
    db.exec('ALTER TABLE templates ADD COLUMN hidden_in_control INTEGER NOT NULL DEFAULT 0');
  }
  const folderCols = db.prepare('PRAGMA table_info(template_folders)').all();
  const folderNames = new Set(folderCols.map((c) => c.name));
  if (!folderNames.has('hidden_in_control')) {
    db.exec('ALTER TABLE template_folders ADD COLUMN hidden_in_control INTEGER NOT NULL DEFAULT 0');
  }
}

/** @param {Database} db */
function ensureUeTemplatesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ue_templates (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      data       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/** @param {Database} db */
function ensureChannelVsColumns(db) {
  const cols = db.prepare(`PRAGMA table_info(channels)`).all();
  const names = new Set(cols.map((c) => c.name));
  const add = (name, ddl) => {
    if (!names.has(name)) db.exec(`ALTER TABLE channels ADD COLUMN ${ddl}`);
  };
  add('render_backend', `render_backend TEXT NOT NULL DEFAULT 'html'`);
  add('unreal_endpoint', `unreal_endpoint TEXT NOT NULL DEFAULT ''`);
  add('unreal_ndi_source', `unreal_ndi_source TEXT NOT NULL DEFAULT ''`);
  add('vs_input_device', `vs_input_device INTEGER NOT NULL DEFAULT -1`);
  add('vs_bg_file', `vs_bg_file TEXT NOT NULL DEFAULT ''`);
  add('vs_cam_file', `vs_cam_file TEXT NOT NULL DEFAULT ''`);
  add('unreal_pad', `unreal_pad TEXT NOT NULL DEFAULT '[]'`);
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
function ensureMediaAssetColumns(db) {
  const cols = db.prepare('PRAGMA table_info(media_assets)').all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('status')) {
    db.exec(`ALTER TABLE media_assets ADD COLUMN status TEXT NOT NULL DEFAULT 'ready'`);
  }
  if (!names.has('source_relative_path')) {
    db.exec('ALTER TABLE media_assets ADD COLUMN source_relative_path TEXT');
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

/**
 * Soft-migrate auth_groups / permissions / template_locks and bootstrap
 * system groups + attach users without group_id.
 * @param {Database} db
 */
function ensureAuthGroupsBootstrap(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_groups (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      is_system  INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS auth_group_permissions (
      group_id   TEXT NOT NULL REFERENCES auth_groups(id) ON DELETE CASCADE,
      permission TEXT NOT NULL,
      PRIMARY KEY (group_id, permission)
    );
    CREATE TABLE IF NOT EXISTS template_locks (
      template_id  TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      username     TEXT NOT NULL,
      locked_at    TEXT NOT NULL DEFAULT (datetime('now')),
      heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const userCols = db.prepare('PRAGMA table_info(users)').all();
  const userColNames = new Set(userCols.map((c) => c.name));
  if (!userColNames.has('group_id')) {
    db.exec('ALTER TABLE users ADD COLUMN group_id TEXT');
  }

  const getGroupByName = db.prepare('SELECT id, name, is_system FROM auth_groups WHERE name = ?');
  const insertGroup = db.prepare(
    `INSERT INTO auth_groups (id, name, is_system) VALUES (?, ?, ?)
     ON CONFLICT(name) DO NOTHING`,
  );
  const insertPerm = db.prepare(
    `INSERT INTO auth_group_permissions (group_id, permission) VALUES (?, ?)
     ON CONFLICT(group_id, permission) DO NOTHING`,
  );

  let admins = getGroupByName.get(ADMINISTRATORS_GROUP_NAME);
  if (!admins) {
    const id = randomUUID();
    insertGroup.run(id, ADMINISTRATORS_GROUP_NAME, 1);
    admins = getGroupByName.get(ADMINISTRATORS_GROUP_NAME);
  } else {
    db.prepare('UPDATE auth_groups SET is_system = 1 WHERE id = ?').run(admins.id);
  }

  let operators = getGroupByName.get(OPERATORS_GROUP_NAME);
  if (!operators) {
    const id = randomUUID();
    insertGroup.run(id, OPERATORS_GROUP_NAME, 0);
    operators = getGroupByName.get(OPERATORS_GROUP_NAME);
  }

  for (const perm of BOOTSTRAP_ALL_PERMISSIONS) {
    insertPerm.run(admins.id, perm);
  }
  for (const perm of ['control', 'template_editor']) {
    insertPerm.run(operators.id, perm);
  }

  db.prepare(
    `UPDATE users SET group_id = ?, role = 'admin', updated_at = datetime('now')
     WHERE role = 'admin' AND (group_id IS NULL OR group_id = '')`,
  ).run(admins.id);

  db.prepare(
    `UPDATE users SET group_id = ?, role = 'operator', updated_at = datetime('now')
     WHERE (group_id IS NULL OR group_id = '') AND role != 'admin'`,
  ).run(operators.id);
}

// ---------------------------------------------------------------------------
// templates
// ---------------------------------------------------------------------------

function mapTemplateRow(row) {
  const hidden = Boolean(row.hidden_in_control);
  return {
    id: row.id,
    name: row.name,
    folder_id: row.folder_id ?? null,
    folderId: row.folder_id ?? null,
    hidden_in_control: hidden,
    hiddenInControl: hidden,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export const templatesDao = (db) => ({
  /**
   * @param {{ folderId?: string }} [opts]
   * folderId: omit/undefined = all; '__none__' = unfiled only; else that folder.
   */
  all(opts = {}) {
    const folderId = opts.folderId;
    let rows;
    if (!folderId || folderId === '__all__') {
      rows = db.prepare(
        `SELECT id, name, folder_id, hidden_in_control, created_at, updated_at
         FROM templates ORDER BY updated_at DESC`,
      ).all();
    } else if (folderId === '__none__') {
      rows = db.prepare(
        `SELECT id, name, folder_id, hidden_in_control, created_at, updated_at FROM templates
         WHERE folder_id IS NULL ORDER BY updated_at DESC`,
      ).all();
    } else {
      rows = db.prepare(
        `SELECT id, name, folder_id, hidden_in_control, created_at, updated_at FROM templates
         WHERE folder_id = ? ORDER BY updated_at DESC`,
      ).all(folderId);
    }
    return rows.map((row) => mapTemplateRow(row));
  },
  get(id) {
    const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(id);
    if (!row) return null;
    return {
      ...mapTemplateRow(row),
      data: JSON.parse(row.data),
    };
  },
  create({ id, name, data, folderId = null, hiddenInControl = false }) {
    db.prepare(
      `INSERT INTO templates (id, name, data, folder_id, hidden_in_control)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, name, JSON.stringify(data), folderId || null, hiddenInControl ? 1 : 0);
    return this.get(id);
  },
  update(id, { name, data, folderId, hiddenInControl } = {}) {
    const cur = db.prepare('SELECT * FROM templates WHERE id = ?').get(id);
    if (!cur) return null;
    const nextFolder = folderId !== undefined
      ? (folderId || null)
      : (cur.folder_id ?? null);
    const nextHidden = hiddenInControl !== undefined
      ? (hiddenInControl ? 1 : 0)
      : (cur.hidden_in_control ? 1 : 0);
    db.prepare(
      `UPDATE templates SET name = ?, data = ?, folder_id = ?, hidden_in_control = ?,
       updated_at = datetime('now') WHERE id = ?`,
    ).run(
      name ?? cur.name,
      data !== undefined ? JSON.stringify(data) : cur.data,
      nextFolder,
      nextHidden,
      id,
    );
    return this.get(id);
  },
  remove(id) {
    return db.prepare('DELETE FROM templates WHERE id = ?').run(id).changes > 0;
  },
});

// ---------------------------------------------------------------------------
// template_folders (one-level grouping for Templates library)
// ---------------------------------------------------------------------------

export const templateFoldersDao = (db) => ({
  all() {
    return db.prepare(
      `SELECT id, name, sort_order AS sortOrder,
              hidden_in_control,
              created_at AS createdAt, updated_at AS updatedAt
       FROM template_folders ORDER BY sort_order ASC, name ASC`,
    ).all().map(mapFolderRow);
  },
  get(id) {
    const row = db.prepare(
      `SELECT id, name, sort_order AS sortOrder,
              hidden_in_control,
              created_at AS createdAt, updated_at AS updatedAt
       FROM template_folders WHERE id = ?`,
    ).get(id);
    return row ? mapFolderRow(row) : null;
  },
  create({ id, name, sortOrder = 0, hiddenInControl = false }) {
    db.prepare(
      `INSERT INTO template_folders (id, name, sort_order, hidden_in_control)
       VALUES (?, ?, ?, ?)`,
    ).run(id, name, sortOrder, hiddenInControl ? 1 : 0);
    return this.get(id);
  },
  update(id, { name, sortOrder, hiddenInControl } = {}) {
    const cur = db.prepare('SELECT * FROM template_folders WHERE id = ?').get(id);
    if (!cur) return null;
    const nextHidden = hiddenInControl !== undefined
      ? (hiddenInControl ? 1 : 0)
      : (cur.hidden_in_control ? 1 : 0);
    db.prepare(
      `UPDATE template_folders SET name = ?, sort_order = ?, hidden_in_control = ?,
       updated_at = datetime('now') WHERE id = ?`,
    ).run(
      name ?? cur.name,
      sortOrder !== undefined ? sortOrder : cur.sort_order,
      nextHidden,
      id,
    );
    return this.get(id);
  },
  remove(id) {
    const tx = db.transaction(() => {
      db.prepare('UPDATE templates SET folder_id = NULL WHERE folder_id = ?').run(id);
      return db.prepare('DELETE FROM template_folders WHERE id = ?').run(id).changes > 0;
    });
    return tx();
  },
});

function mapFolderRow(row) {
  const hidden = Boolean(row.hidden_in_control);
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sortOrder ?? row.sort_order ?? 0,
    hiddenInControl: hidden,
    hidden_in_control: hidden,
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at,
    created_at: row.createdAt ?? row.created_at,
    updated_at: row.updatedAt ?? row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// ue_templates (Unreal Blueprint catalog — ZeroDensity-style)
// ---------------------------------------------------------------------------

function parseUeTemplateData(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) {
    return { schemaVersion: 1, rcObjectPath: '', takeIn: null, takeOut: null, actions: [], variables: [] };
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export const ueTemplatesDao = (db) => ({
  all() {
    return db.prepare('SELECT id, name, created_at, updated_at FROM ue_templates ORDER BY updated_at DESC').all();
  },
  get(id) {
    const row = db.prepare('SELECT * FROM ue_templates WHERE id = ?').get(id);
    if (!row) return null;
    return { ...row, data: parseUeTemplateData(row.data) };
  },
  create({ id, name, data }) {
    db.prepare('INSERT INTO ue_templates (id, name, data) VALUES (?, ?, ?)').run(
      id, name, JSON.stringify(data ?? {}),
    );
    return this.get(id);
  },
  update(id, { name, data }) {
    const cur = db.prepare('SELECT * FROM ue_templates WHERE id = ?').get(id);
    if (!cur) return null;
    const next = {
      name: name ?? cur.name,
      data: data !== undefined ? JSON.stringify(data) : cur.data,
    };
    db.prepare(
      `UPDATE ue_templates SET name = ?, data = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(next.name, next.data, id);
    return this.get(id);
  },
  remove(id) {
    return db.prepare('DELETE FROM ue_templates WHERE id = ?').run(id).changes > 0;
  },
});

// ---------------------------------------------------------------------------
// channels
// ---------------------------------------------------------------------------

const MAX_CHANNELS = 8;

const CHANNEL_VS_DEFAULTS = {
  render_backend: 'html',
  unreal_endpoint: '',
  unreal_ndi_source: '',
  vs_input_device: -1,
  vs_bg_file: '',
  vs_cam_file: '',
  unreal_pad: '[]',
};

function parseUnrealPad(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapChannelRow(row) {
  if (!row) return null;
  return {
    ...row,
    render_backend: row.render_backend ?? 'html',
    unreal_endpoint: row.unreal_endpoint ?? '',
    unreal_ndi_source: row.unreal_ndi_source ?? '',
    vs_input_device: row.vs_input_device ?? -1,
    vs_bg_file: row.vs_bg_file ?? '',
    vs_cam_file: row.vs_cam_file ?? '',
    unreal_pad: parseUnrealPad(row.unreal_pad),
  };
}

export const channelsDao = (db) => ({
  MAX: MAX_CHANNELS,
  all() {
    return db.prepare('SELECT * FROM channels ORDER BY created_at ASC').all().map(mapChannelRow);
  },
  get(id) {
    return mapChannelRow(db.prepare('SELECT * FROM channels WHERE id = ?').get(id) ?? null);
  },
  count() {
    return db.prepare('SELECT COUNT(*) AS n FROM channels').get().n;
  },
  create({
    id, name, output_mode, device_index, display_mode, keyer_mode, stream_url,
    render_backend, unreal_endpoint, unreal_ndi_source, vs_input_device,
    vs_bg_file, vs_cam_file, unreal_pad,
  }) {
    if (this.count() >= MAX_CHANNELS) {
      const err = new Error(`max ${MAX_CHANNELS} channels reached`);
      err.code = 'MAX_CHANNELS';
      throw err;
    }
    const padJson = Array.isArray(unreal_pad) ? JSON.stringify(unreal_pad) : (unreal_pad ?? CHANNEL_VS_DEFAULTS.unreal_pad);
    db.prepare(
      `INSERT INTO channels (
         id, name, output_mode, device_index, display_mode, keyer_mode, stream_url,
         render_backend, unreal_endpoint, unreal_ndi_source, vs_input_device,
         vs_bg_file, vs_cam_file, unreal_pad
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, name,
      output_mode ?? 'browser',
      device_index ?? -1,
      display_mode ?? 'HD1080i50',
      keyer_mode ?? 'external',
      stream_url ?? '',
      render_backend ?? CHANNEL_VS_DEFAULTS.render_backend,
      unreal_endpoint ?? '',
      unreal_ndi_source ?? '',
      vs_input_device ?? -1,
      vs_bg_file ?? '',
      vs_cam_file ?? '',
      padJson,
    );
    return this.get(id);
  },
  update(id, patch) {
    const cur = this.get(id);
    if (!cur) return null;
    const nextPad = patch.unreal_pad !== undefined
      ? (Array.isArray(patch.unreal_pad) ? JSON.stringify(patch.unreal_pad) : String(patch.unreal_pad))
      : JSON.stringify(cur.unreal_pad ?? []);
    const next = {
      name: patch.name ?? cur.name,
      output_mode: patch.output_mode ?? cur.output_mode,
      device_index: patch.device_index ?? cur.device_index,
      display_mode: patch.display_mode ?? cur.display_mode,
      keyer_mode: patch.keyer_mode ?? cur.keyer_mode,
      stream_url: patch.stream_url ?? cur.stream_url,
      render_backend: patch.render_backend ?? cur.render_backend,
      unreal_endpoint: patch.unreal_endpoint ?? cur.unreal_endpoint,
      unreal_ndi_source: patch.unreal_ndi_source ?? cur.unreal_ndi_source,
      vs_input_device: patch.vs_input_device ?? cur.vs_input_device,
      vs_bg_file: patch.vs_bg_file ?? cur.vs_bg_file,
      vs_cam_file: patch.vs_cam_file ?? cur.vs_cam_file,
      unreal_pad: nextPad,
    };
    db.prepare(
      `UPDATE channels SET
         name=?, output_mode=?, device_index=?, display_mode=?, keyer_mode=?, stream_url=?,
         render_backend=?, unreal_endpoint=?, unreal_ndi_source=?, vs_input_device=?,
         vs_bg_file=?, vs_cam_file=?, unreal_pad=?
       WHERE id=?`,
    ).run(
      next.name, next.output_mode, next.device_index, next.display_mode, next.keyer_mode, next.stream_url,
      next.render_backend, next.unreal_endpoint, next.unreal_ndi_source, next.vs_input_device,
      next.vs_bg_file, next.vs_cam_file, next.unreal_pad, id,
    );
    return this.get(id);
  },
  remove(id) {
    return db.prepare('DELETE FROM channels WHERE id = ?').run(id).changes > 0;
  },
});

// ---------------------------------------------------------------------------
// rundowns
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function normalizeSlotVars(input) {
  if (!isPlainObject(input)) return {};
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof k !== 'string' || !k.trim()) continue;
    if (typeof v === 'string' || typeof v === 'number') {
      out[k] = v;
      continue;
    }
    if (typeof v === 'boolean') {
      out[k] = v ? 'true' : 'false';
    }
  }
  return out;
}

function normalizeRundownSlots(input) {
  if (!Array.isArray(input)) return { slots: [], changed: true };
  const normalized = [];
  let changed = false;
  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    if (!isPlainObject(raw)) {
      changed = true;
      continue;
    }

    const templateId = typeof raw.templateId === 'string'
      ? raw.templateId.trim()
      : '';
    if (!templateId) {
      changed = true;
      continue;
    }

    const slotIdCandidate = typeof raw.slotId === 'string'
      ? raw.slotId.trim()
      : (typeof raw.id === 'string' ? raw.id.trim() : '');
    const slotId = slotIdCandidate || randomUUID();
    const name = typeof raw.name === 'string'
      ? raw.name.trim()
      : (typeof raw.label === 'string' ? raw.label.trim() : '');
    const vars = normalizeSlotVars(raw.vars ?? raw.variables ?? {});
    const dataElementId = typeof raw.dataElementId === 'string' && raw.dataElementId.trim()
      ? raw.dataElementId.trim()
      : null;
    const kind = raw.kind === 'ue' ? 'ue' : 'html';
    if (raw.kind && raw.kind !== kind) changed = true;
    const slot = {
      slotId,
      templateId,
      kind,
      name: name || `Slot ${i + 1}`,
      vars,
      ...(dataElementId ? { dataElementId } : {}),
    };
    normalized.push(slot);

    if (!slotIdCandidate) changed = true;
    if ('id' in raw || 'label' in raw || 'variables' in raw) changed = true;
    if (dataElementId && raw.dataElementId !== dataElementId) changed = true;
  }

  const stable = JSON.stringify(input) === JSON.stringify(normalized);
  return { slots: normalized, changed: changed || !stable };
}

function parseSlots(rawJson) {
  try {
    return JSON.parse(rawJson);
  } catch {
    return [];
  }
}

export const rundownsDao = (db) => ({
  all({ channelId } = {}) {
    const rows = channelId
      ? db.prepare(
        'SELECT * FROM rundowns WHERE channel_id = ? ORDER BY sort_order ASC, created_at ASC',
      ).all(channelId)
      : db.prepare('SELECT * FROM rundowns ORDER BY sort_order ASC, created_at ASC').all();
    return rows.map((row) => {
      const parsed = parseSlots(row.slots);
      const { slots, changed } = normalizeRundownSlots(parsed);
      if (changed) {
        db.prepare(
          `UPDATE rundowns
           SET slots = ?, updated_at = datetime('now')
           WHERE id = ?`,
        ).run(JSON.stringify(slots), row.id);
      }
      return { ...row, slots };
    });
  },
  get(id) {
    const r = db.prepare('SELECT * FROM rundowns WHERE id = ?').get(id);
    if (!r) return null;
    const parsed = parseSlots(r.slots);
    const { slots, changed } = normalizeRundownSlots(parsed);
    if (changed) {
      db.prepare(
        `UPDATE rundowns
         SET slots = ?, updated_at = datetime('now')
         WHERE id = ?`,
      ).run(JSON.stringify(slots), id);
    }
    return { ...r, slots };
  },
  create({ id, name, channel_id, slots }) {
    const normalizedName = typeof name === 'string' && name.trim() ? name.trim() : 'Rundown';
    const normalizedChannelId = typeof channel_id === 'string' && channel_id.trim()
      ? channel_id.trim()
      : null;
    const normalizedSlots = normalizeRundownSlots(slots).slots;
    db.prepare(
      'INSERT INTO rundowns (id, name, channel_id, slots, sort_order) VALUES (?, ?, ?, ?, ?)',
    ).run(id, normalizedName, normalizedChannelId, JSON.stringify(normalizedSlots), this.count());
    return this.get(id);
  },
  count() {
    return db.prepare('SELECT COUNT(*) AS n FROM rundowns').get().n;
  },
  update(id, patch) {
    const cur = this.get(id);
    if (!cur) return null;
    const next = {
      name: (typeof patch.name === 'string' && patch.name.trim()) ? patch.name.trim() : cur.name,
      channel_id: patch.channel_id !== undefined
        ? ((typeof patch.channel_id === 'string' && patch.channel_id.trim()) ? patch.channel_id.trim() : null)
        : cur.channel_id,
      slots: patch.slots !== undefined
        ? JSON.stringify(normalizeRundownSlots(patch.slots).slots)
        : JSON.stringify(cur.slots),
    };
    db.prepare(
      `UPDATE rundowns SET name=?, channel_id=?, slots=?, updated_at=datetime('now') WHERE id=?`,
    ).run(next.name, next.channel_id, next.slots, id);
    return this.get(id);
  },
  remove(id) {
    return db.prepare('DELETE FROM rundowns WHERE id = ?').run(id).changes > 0;
  },
  /**
   * Reorder by an ordered list of ids (sets sort_order = index).
   * When channelId is set, only that channel's rundowns are returned after reorder.
   */
  reorder(ids, { channelId } = {}) {
    const tx = db.transaction((list) => {
      for (let i = 0; i < list.length; i++) {
        db.prepare('UPDATE rundowns SET sort_order = ? WHERE id = ?').run(i, list[i]);
      }
    });
    tx(ids);
    return this.all({ channelId });
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
// auth (phase 6.2 baseline + groups/permissions)
// ---------------------------------------------------------------------------

const USER_PUBLIC_SELECT = `
  u.id, u.tenant_id, u.username,
  u.role, u.group_id, u.is_active, u.created_at, u.updated_at,
  g.name AS group_name
`;

function roleForGroupName(groupName) {
  return groupName === ADMINISTRATORS_GROUP_NAME ? 'admin' : 'operator';
}

function mapGroupRow(row, permissions = []) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    is_system: row.is_system,
    isSystem: !!row.is_system,
    created_at: row.created_at,
    updated_at: row.updated_at,
    permissions,
  };
}

export const authDao = (db) => ({
  findUserByUsername(username) {
    return db.prepare(
      `SELECT ${USER_PUBLIC_SELECT}, u.password_hash, u.password_salt
       FROM users u
       LEFT JOIN auth_groups g ON g.id = u.group_id
       WHERE u.username = ?`,
    ).get(username);
  },
  getUserById(id) {
    return db.prepare(
      `SELECT ${USER_PUBLIC_SELECT}
       FROM users u
       LEFT JOIN auth_groups g ON g.id = u.group_id
       WHERE u.id = ?`,
    ).get(id);
  },
  listUsers() {
    return db.prepare(
      `SELECT ${USER_PUBLIC_SELECT}
       FROM users u
       LEFT JOIN auth_groups g ON g.id = u.group_id
       ORDER BY u.created_at ASC`,
    ).all();
  },
  createUser({ tenantId, username, passwordHash, passwordSalt, groupId, role }) {
    const id = randomUUID();
    let resolvedRole = role || 'operator';
    let resolvedGroupId = groupId ?? null;
    if (resolvedGroupId) {
      const group = this.getGroup(resolvedGroupId);
      if (!group) throw new Error('GROUP_NOT_FOUND');
      resolvedRole = roleForGroupName(group.name);
    } else if (resolvedRole === 'admin') {
      const admins = db.prepare('SELECT id FROM auth_groups WHERE name = ?').get(ADMINISTRATORS_GROUP_NAME);
      resolvedGroupId = admins?.id ?? null;
    } else {
      const operators = db.prepare('SELECT id FROM auth_groups WHERE name = ?').get(OPERATORS_GROUP_NAME);
      resolvedGroupId = operators?.id ?? null;
    }
    db.prepare(
      `INSERT INTO users (id, tenant_id, username, password_hash, password_salt, role, group_id, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(id, tenantId, username, passwordHash, passwordSalt, resolvedRole, resolvedGroupId);
    return this.getUserById(id);
  },
  updateUser({ id, username, passwordHash, passwordSalt, groupId, isActive, role }) {
    const existing = db.prepare(
      `SELECT id, username, password_hash, password_salt, group_id, role, is_active
       FROM users WHERE id = ?`,
    ).get(id);
    if (!existing) return null;

    let nextUsername = existing.username;
    let nextHash = existing.password_hash;
    let nextSalt = existing.password_salt;
    let nextGroupId = existing.group_id;
    let nextRole = existing.role;
    let nextActive = existing.is_active;

    if (typeof username === 'string' && username.trim()) {
      nextUsername = username.trim();
    }
    if (typeof passwordHash === 'string' && typeof passwordSalt === 'string') {
      nextHash = passwordHash;
      nextSalt = passwordSalt;
    }
    if (groupId !== undefined) {
      if (groupId === null || groupId === '') {
        nextGroupId = null;
      } else {
        const group = this.getGroup(groupId);
        if (!group) throw new Error('GROUP_NOT_FOUND');
        nextGroupId = group.id;
        nextRole = roleForGroupName(group.name);
      }
    }
    if (role !== undefined && groupId === undefined) {
      if (role !== 'admin' && role !== 'operator') throw new Error('ROLE_INVALID');
      nextRole = role;
    }
    if (isActive !== undefined) {
      nextActive = isActive ? 1 : 0;
    }

    db.prepare(
      `UPDATE users
       SET username = ?, password_hash = ?, password_salt = ?, group_id = ?, role = ?,
           is_active = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(nextUsername, nextHash, nextSalt, nextGroupId, nextRole, nextActive, id);
    return this.getUserById(id);
  },
  setUserActive(id, isActive) {
    return this.updateUser({ id, isActive: !!isActive });
  },
  countActiveAdministrators({ excludeUserId } = {}) {
    const admins = db.prepare('SELECT id FROM auth_groups WHERE name = ?').get(ADMINISTRATORS_GROUP_NAME);
    if (!admins) return 0;
    if (excludeUserId) {
      return db.prepare(
        `SELECT COUNT(*) AS n FROM users
         WHERE group_id = ? AND is_active = 1 AND id != ?`,
      ).get(admins.id, excludeUserId).n;
    }
    return db.prepare(
      `SELECT COUNT(*) AS n FROM users
       WHERE group_id = ? AND is_active = 1`,
    ).get(admins.id).n;
  },
  getUserPermissions(userId) {
    const row = this.getUserById(userId);
    if (!row) return [];
    if (!row.group_id) {
      // Safety: legacy admin without group still has full access.
      if (row.role === 'admin') return [...BOOTSTRAP_ALL_PERMISSIONS];
      return [];
    }
    return db.prepare(
      `SELECT permission FROM auth_group_permissions
       WHERE group_id = ?
       ORDER BY permission ASC`,
    ).all(row.group_id).map((r) => r.permission);
  },
  listGroups() {
    const groups = db.prepare(
      `SELECT id, name, is_system, created_at, updated_at
       FROM auth_groups
       ORDER BY name ASC`,
    ).all();
    return groups.map((g) => mapGroupRow(g, this.getGroupPermissions(g.id)));
  },
  getGroup(id) {
    const row = db.prepare(
      `SELECT id, name, is_system, created_at, updated_at
       FROM auth_groups WHERE id = ?`,
    ).get(id);
    if (!row) return null;
    return mapGroupRow(row, this.getGroupPermissions(id));
  },
  getGroupByName(name) {
    const row = db.prepare(
      `SELECT id, name, is_system, created_at, updated_at
       FROM auth_groups WHERE name = ?`,
    ).get(name);
    if (!row) return null;
    return mapGroupRow(row, this.getGroupPermissions(row.id));
  },
  getGroupPermissions(groupId) {
    return db.prepare(
      `SELECT permission FROM auth_group_permissions
       WHERE group_id = ?
       ORDER BY permission ASC`,
    ).all(groupId).map((r) => r.permission);
  },
  createGroup({ name, permissions = [] }) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO auth_groups (id, name, is_system) VALUES (?, ?, 0)`,
    ).run(id, name);
    this.setGroupPermissions(id, permissions);
    return this.getGroup(id);
  },
  updateGroup(id, { name } = {}) {
    const existing = this.getGroup(id);
    if (!existing) return null;
    if (typeof name === 'string' && name.trim()) {
      if (existing.name === ADMINISTRATORS_GROUP_NAME && name.trim() !== ADMINISTRATORS_GROUP_NAME) {
        throw new Error('ADMINISTRATORS_IMMUTABLE');
      }
      db.prepare(
        `UPDATE auth_groups SET name = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(name.trim(), id);
    }
    return this.getGroup(id);
  },
  setGroupPermissions(groupId, permissions) {
    const existing = this.getGroup(groupId);
    if (!existing) throw new Error('GROUP_NOT_FOUND');
    let perms = [...new Set(permissions)];
    // administrators: settings is mandatory; other permissions may be removed.
    if (existing.name === ADMINISTRATORS_GROUP_NAME) {
      if (!perms.includes('settings')) perms.push('settings');
    }
    const del = db.prepare('DELETE FROM auth_group_permissions WHERE group_id = ?');
    const ins = db.prepare(
      `INSERT INTO auth_group_permissions (group_id, permission) VALUES (?, ?)`,
    );
    const tx = db.transaction((list) => {
      del.run(groupId);
      for (const p of list) ins.run(groupId, p);
      db.prepare(
        `UPDATE auth_groups SET updated_at = datetime('now') WHERE id = ?`,
      ).run(groupId);
    });
    tx(perms);
    return this.getGroup(groupId);
  },
  deleteGroup(id) {
    const existing = this.getGroup(id);
    if (!existing) return false;
    if (existing.name === ADMINISTRATORS_GROUP_NAME) {
      throw new Error('ADMINISTRATORS_IMMUTABLE');
    }
    const inUse = db.prepare(
      `SELECT COUNT(*) AS n FROM users WHERE group_id = ?`,
    ).get(id).n;
    if (inUse > 0) throw new Error('GROUP_IN_USE');
    db.prepare('DELETE FROM auth_groups WHERE id = ?').run(id);
    return true;
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
              u.username, u.role, u.is_active, u.group_id, g.name AS group_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN auth_groups g ON g.id = u.group_id
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
// template locks (editor exclusive edit)
// ---------------------------------------------------------------------------

function mapLockRow(row) {
  if (!row) return null;
  return {
    template_id: row.template_id,
    templateId: row.template_id,
    user_id: row.user_id,
    userId: row.user_id,
    username: row.username,
    locked_at: row.locked_at,
    lockedAt: row.locked_at,
    heartbeat_at: row.heartbeat_at,
    heartbeatAt: row.heartbeat_at,
  };
}

export const templateLocksDao = (db) => ({
  getLock(templateId) {
    return mapLockRow(
      db.prepare(
        `SELECT template_id, user_id, username, locked_at, heartbeat_at
         FROM template_locks WHERE template_id = ?`,
      ).get(templateId),
    );
  },
  acquireLock(templateId, userId, username) {
    const existing = this.getLock(templateId);
    if (!existing) {
      db.prepare(
        `INSERT INTO template_locks (template_id, user_id, username, locked_at, heartbeat_at)
         VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
      ).run(templateId, userId, username);
      return mapLockRow(this.getLock(templateId));
    }
    if (existing.user_id === userId) {
      db.prepare(
        `UPDATE template_locks
         SET username = ?, heartbeat_at = datetime('now')
         WHERE template_id = ? AND user_id = ?`,
      ).run(username, templateId, userId);
      return mapLockRow(this.getLock(templateId));
    }
    return null;
  },
  heartbeatLock(templateId, userId) {
    const result = db.prepare(
      `UPDATE template_locks
       SET heartbeat_at = datetime('now')
       WHERE template_id = ? AND user_id = ?`,
    ).run(templateId, userId);
    if (result.changes === 0) return null;
    return this.getLock(templateId);
  },
  releaseLock(templateId, userId) {
    const result = db.prepare(
      `DELETE FROM template_locks WHERE template_id = ? AND user_id = ?`,
    ).run(templateId, userId);
    return result.changes > 0;
  },
  stealStaleLock(templateId, userId, username) {
    const existing = this.getLock(templateId);
    if (!existing) {
      return this.acquireLock(templateId, userId, username);
    }
    if (existing.user_id === userId) {
      return this.acquireLock(templateId, userId, username);
    }
    const stale = db.prepare(
      `SELECT 1 AS ok FROM template_locks
       WHERE template_id = ?
         AND heartbeat_at < datetime('now', ?)`,
    ).get(templateId, `-${LOCK_STALE_SECONDS} seconds`);
    if (!stale) return null;
    db.prepare(
      `UPDATE template_locks
       SET user_id = ?, username = ?, locked_at = datetime('now'), heartbeat_at = datetime('now')
       WHERE template_id = ?`,
    ).run(userId, username, templateId);
    return this.getLock(templateId);
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
  set(command, { bringToFront = true, orderIndex: orderIndexOpt } = {}) {
    const existing = db.prepare(
      'SELECT order_index FROM on_air WHERE channel_id = ? AND template_id = ?',
    ).get(command.channelId, command.templateId);
    const max = db.prepare(
      'SELECT COALESCE(MAX(order_index), 0) AS n FROM on_air WHERE channel_id = ?',
    ).get(command.channelId).n;
    let orderIndex;
    if (typeof orderIndexOpt === 'number' && Number.isFinite(orderIndexOpt)) {
      orderIndex = Math.round(orderIndexOpt);
    } else if (bringToFront) {
      orderIndex = max + 1;
    } else {
      orderIndex = existing ? existing.order_index : (max + 1);
    }
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

// ---------------------------------------------------------------------------
// media library (tags + assets)
// ---------------------------------------------------------------------------

function mapMediaAssetRow(row, tagIds = []) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    displayName: row.display_name,
    filename: row.filename,
    relativePath: row.relative_path,
    url: `/uploads/${row.relative_path}`,
    posterPath: row.poster_path,
    posterUrl: row.poster_path ? `/uploads/${row.poster_path}` : null,
    format: row.format,
    width: row.width,
    height: row.height,
    hasAlpha: Boolean(row.has_alpha),
    durationSec: row.duration_sec,
    durationFrames: row.duration_frames,
    fps: row.fps,
    locked: Boolean(row.locked),
    status: row.status || 'ready',
    sourceRelativePath: row.source_relative_path ?? null,
    tagIds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const mediaTagsDao = (db) => ({
  all(search = '') {
    const q = search.trim().toLowerCase();
    if (!q) {
      return db.prepare('SELECT * FROM media_tags ORDER BY name COLLATE NOCASE ASC').all();
    }
    return db.prepare(
      'SELECT * FROM media_tags WHERE lower(name) LIKE ? ORDER BY name COLLATE NOCASE ASC',
    ).all(`%${q}%`);
  },
  get(id) {
    return db.prepare('SELECT * FROM media_tags WHERE id = ?').get(id) ?? null;
  },
  getByName(name) {
    return db.prepare('SELECT * FROM media_tags WHERE name = ? COLLATE NOCASE').get(name.trim()) ?? null;
  },
  create(name) {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const existing = this.getByName(trimmed);
    if (existing) return existing;
    const id = randomUUID();
    db.prepare('INSERT INTO media_tags (id, name) VALUES (?, ?)').run(id, trimmed);
    return this.get(id);
  },
  remove(id) {
    return db.prepare('DELETE FROM media_tags WHERE id = ?').run(id).changes > 0;
  },
});

export const mediaAssetsDao = (db) => ({
  _tagIds(assetId) {
    return db.prepare(
      'SELECT tag_id FROM media_asset_tags WHERE asset_id = ?',
    ).all(assetId).map((r) => r.tag_id);
  },
  get(id) {
    const row = db.prepare('SELECT * FROM media_assets WHERE id = ?').get(id);
    return mapMediaAssetRow(row, row ? this._tagIds(row.id) : []);
  },
  getByRelativePath(relativePath) {
    const row = db.prepare('SELECT * FROM media_assets WHERE relative_path = ?').get(relativePath);
    return mapMediaAssetRow(row, row ? this._tagIds(row.id) : []);
  },
  getProcessingBySource(sourceRelativePath) {
    const row = db.prepare(
      `SELECT * FROM media_assets WHERE source_relative_path = ? AND status = 'processing'`,
    ).get(sourceRelativePath);
    return mapMediaAssetRow(row, row ? this._tagIds(row.id) : []);
  },
  list({ type, search = '', tagIds = [] } = {}) {
    const params = [];
    let sql = 'SELECT DISTINCT a.* FROM media_assets a';
    if (tagIds.length > 0) {
      sql += ' JOIN media_asset_tags mat ON mat.asset_id = a.id';
    }
    const where = [];
    if (type) {
      where.push('a.type = ?');
      params.push(type);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      where.push('(lower(a.display_name) LIKE ? OR lower(a.filename) LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }
    if (tagIds.length > 0) {
      const placeholders = tagIds.map(() => '?').join(',');
      where.push(`mat.tag_id IN (${placeholders})`);
      params.push(...tagIds);
      if (tagIds.length > 1) {
        sql += ` GROUP BY a.id HAVING COUNT(DISTINCT mat.tag_id) = ${tagIds.length}`;
      }
    }
    if (where.length > 0) {
      sql += ` WHERE ${where.join(' AND ')}`;
    }
    sql += ' ORDER BY a.display_name COLLATE NOCASE ASC';
    const rows = db.prepare(sql).all(...params);
    return rows.map((row) => mapMediaAssetRow(row, this._tagIds(row.id)));
  },
  create(asset) {
    db.prepare(
      `INSERT INTO media_assets (
        id, type, display_name, filename, relative_path, poster_path, format,
        width, height, has_alpha, duration_sec, duration_frames, fps, locked,
        status, source_relative_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      asset.id,
      asset.type,
      asset.displayName,
      asset.filename,
      asset.relativePath,
      asset.posterPath ?? null,
      asset.format ?? '',
      asset.width ?? 0,
      asset.height ?? 0,
      asset.hasAlpha ? 1 : 0,
      asset.durationSec ?? null,
      asset.durationFrames ?? null,
      asset.fps ?? null,
      asset.locked ? 1 : 0,
      asset.status ?? 'ready',
      asset.sourceRelativePath ?? null,
    );
    if (asset.tagIds?.length) {
      this.setTags(asset.id, asset.tagIds);
    }
    return this.get(asset.id);
  },
  update(id, patch) {
    const cur = db.prepare('SELECT * FROM media_assets WHERE id = ?').get(id);
    if (!cur) return null;
    const next = {
      display_name: patch.displayName ?? cur.display_name,
      locked: patch.locked !== undefined ? (patch.locked ? 1 : 0) : cur.locked,
      status: patch.status ?? cur.status,
      format: patch.format ?? cur.format,
      width: patch.width ?? cur.width,
      height: patch.height ?? cur.height,
      has_alpha: patch.hasAlpha !== undefined ? (patch.hasAlpha ? 1 : 0) : cur.has_alpha,
      duration_sec: patch.durationSec !== undefined ? patch.durationSec : cur.duration_sec,
      duration_frames: patch.durationFrames !== undefined ? patch.durationFrames : cur.duration_frames,
      fps: patch.fps !== undefined ? patch.fps : cur.fps,
      poster_path: patch.posterPath !== undefined ? patch.posterPath : cur.poster_path,
      source_relative_path: patch.sourceRelativePath !== undefined
        ? patch.sourceRelativePath
        : cur.source_relative_path,
    };
    db.prepare(
      `UPDATE media_assets SET
        display_name = ?, locked = ?, status = ?, format = ?,
        width = ?, height = ?, has_alpha = ?,
        duration_sec = ?, duration_frames = ?, fps = ?,
        poster_path = ?, source_relative_path = ?,
        updated_at = datetime('now')
      WHERE id = ?`,
    ).run(
      next.display_name,
      next.locked,
      next.status,
      next.format,
      next.width,
      next.height,
      next.has_alpha,
      next.duration_sec,
      next.duration_frames,
      next.fps,
      next.poster_path,
      next.source_relative_path,
      id,
    );
    if (patch.tagIds !== undefined) {
      this.setTags(id, patch.tagIds);
    }
    return this.get(id);
  },
  setTags(assetId, tagIds) {
    db.prepare('DELETE FROM media_asset_tags WHERE asset_id = ?').run(assetId);
    const ins = db.prepare('INSERT INTO media_asset_tags (asset_id, tag_id) VALUES (?, ?)');
    for (const tagId of tagIds) {
      ins.run(assetId, tagId);
    }
  },
  remove(id) {
    db.prepare('DELETE FROM media_asset_tags WHERE asset_id = ?').run(id);
    return db.prepare('DELETE FROM media_assets WHERE id = ?').run(id).changes > 0;
  },
});
