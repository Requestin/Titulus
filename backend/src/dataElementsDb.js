// backend/src/dataElementsDb.js
//
// Separate SQLite file for DataElements ($TITULUS_DATA/app.db-dataelements).
// A DataElement is a named fill of a template's variables.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS data_elements (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  name TEXT NOT NULL,
  vars TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_de_template ON data_elements(template_id);
CREATE INDEX IF NOT EXISTS idx_de_updated ON data_elements(updated_at);
`;

/**
 * @param {string} dbPath
 * @returns {import('better-sqlite3').Database}
 */
export function openDataElementsDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function normalizeVars(input) {
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

function rowToDataElement(row) {
  let vars = {};
  try {
    vars = normalizeVars(JSON.parse(row.vars));
  } catch {
    vars = {};
  }
  return {
    id: row.id,
    templateId: row.template_id,
    name: row.name,
    vars,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function dataElementsDao(db) {
  return {
    all({ sort = 'updated' } = {}) {
      const orderSql = sort === 'name'
        ? 'ORDER BY name COLLATE NOCASE ASC, updated_at DESC'
        : 'ORDER BY updated_at DESC, name COLLATE NOCASE ASC';
      return db.prepare(`SELECT * FROM data_elements ${orderSql}`).all().map(rowToDataElement);
    },

    get(id) {
      const row = db.prepare('SELECT * FROM data_elements WHERE id = ?').get(id);
      return row ? rowToDataElement(row) : null;
    },

    create({ id, templateId, name, vars, createdBy, updatedBy }) {
      const eid = id || randomUUID();
      const normalizedName = typeof name === 'string' && name.trim() ? name.trim() : 'DataElement';
      const normalizedVars = normalizeVars(vars);
      const by = typeof createdBy === 'string' && createdBy.trim() ? createdBy.trim() : 'unknown';
      const upd = typeof updatedBy === 'string' && updatedBy.trim() ? updatedBy.trim() : by;
      db.prepare(
        `INSERT INTO data_elements (id, template_id, name, vars, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(eid, templateId, normalizedName, JSON.stringify(normalizedVars), by, upd);
      return this.get(eid);
    },

    update(id, { name, vars, updatedBy }) {
      const cur = this.get(id);
      if (!cur) return null;
      const nextName = typeof name === 'string' && name.trim() ? name.trim() : cur.name;
      const nextVars = vars !== undefined ? normalizeVars(vars) : cur.vars;
      const by = typeof updatedBy === 'string' && updatedBy.trim() ? updatedBy.trim() : cur.updatedBy;
      db.prepare(
        `UPDATE data_elements
         SET name = ?, vars = ?, updated_by = ?, updated_at = datetime('now')
         WHERE id = ?`,
      ).run(nextName, JSON.stringify(nextVars), by, id);
      return this.get(id);
    },

    remove(id) {
      return db.prepare('DELETE FROM data_elements WHERE id = ?').run(id).changes > 0;
    },

    removeByTemplateId(templateId) {
      return db.prepare('DELETE FROM data_elements WHERE template_id = ?').run(templateId).changes;
    },
  };
}
