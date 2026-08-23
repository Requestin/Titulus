#!/usr/bin/env node
// Rewrite templates in a *copied* app.db. Never point dest at a live file.
import { copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb, templatesDao } from '../src/db.js';
import { migrateTemplate } from '../src/templateMigration.js';

const source = process.argv[2];
const dest = process.argv[3];
if (!source || !dest) {
  process.stderr.write('Usage: node backend/tools/migrate-templates.mjs <source.db> <dest.db>\n');
  process.exit(1);
}

const sourcePath = resolve(source);
const destPath = resolve(dest);
if (!existsSync(sourcePath)) {
  process.stderr.write(`missing source db: ${sourcePath}\n`);
  process.exit(1);
}
if (sourcePath === destPath) {
  process.stderr.write('refusing to migrate in place; copy the db first\n');
  process.exit(1);
}
if (existsSync(destPath)) {
  process.stderr.write(`refusing to overwrite existing dest: ${destPath}\n`);
  process.exit(1);
}

copyFileSync(sourcePath, destPath);
const db = openDb(destPath);
const dao = templatesDao(db);
const rows = db.prepare('SELECT id FROM templates').all();
let rewritten = 0;
for (const row of rows) {
  const record = dao.get(row.id);
  const migrated = migrateTemplate(record.data);
  if (JSON.stringify(migrated) !== JSON.stringify(record.data)) {
    dao.update(row.id, { data: migrated });
    rewritten += 1;
  }
}
db.close();
process.stdout.write(JSON.stringify({
  dest: destPath,
  templates: rows.length,
  rewritten,
}) + '\n');
