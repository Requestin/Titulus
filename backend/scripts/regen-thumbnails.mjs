#!/usr/bin/env node
// One-shot: regenerate all template thumbnails into $TITULUS_DATA/thumbnails.
// Usage:
//   TITULUS_DATA=/var/lib/titulus node backend/scripts/regen-thumbnails.mjs

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, templatesDao } from '../src/db.js';
import { renderAndSaveThumbnail } from '../src/thumbnailRender.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const DATA_DIR = process.env.TITULUS_DATA
  ? resolve(process.env.TITULUS_DATA)
  : '/var/lib/titulus';
const UPLOADS_DIR = resolve(DATA_DIR, 'uploads');
const RUNTIME = resolve(ROOT, 'backend/public/bg-runtime.js');

const db = openDb(resolve(DATA_DIR, 'app.db'));
const dao = templatesDao(db);
const list = dao.all();

console.log(`[regen-thumbnails] ${list.length} templates → ${DATA_DIR}/thumbnails`);

let ok = 0;
let fail = 0;
for (const row of list) {
  const full = dao.get(row.id);
  if (!full?.data) {
    console.warn(`  skip ${row.id} (no data)`);
    fail += 1;
    continue;
  }
  const template = { ...full.data, id: full.id, name: full.name };
  try {
    const url = await renderAndSaveThumbnail({
      dataDir: DATA_DIR,
      template,
      uploadsDir: UPLOADS_DIR,
      runtimePath: RUNTIME,
    });
    console.log(`  OK  ${full.name} → ${url}`);
    ok += 1;
  } catch (e) {
    console.error(`  FAIL ${full.name}: ${e.message || e}`);
    fail += 1;
  }
}

console.log(`[regen-thumbnails] done ok=${ok} fail=${fail}`);
process.exit(fail ? 1 : 0);
