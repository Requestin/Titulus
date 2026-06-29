// backend/src/db.js
//
// SQLite (better-sqlite3, WAL mode) schema + DAOs for the Titulus control plane
// (DEVELOPMENT_PROMPT §7.2).
//
// Tables: templates, channels, rundowns, settings, on_air.
// On-air persistence (§NFR-1): the on_air table stores the full take command so
// a backend restart can replay the picture to every /ws/renderer client.

import Database from 'better-sqlite3';
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
