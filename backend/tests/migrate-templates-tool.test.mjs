import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { openDb, templatesDao } from '../src/db.js';
import { migrateTemplate } from '../src/templateMigration.js';
import { classifyTemplateCapabilities } from '../../shared/templateCapabilities.mjs';

const toolPath = fileURLToPath(new URL('../tools/migrate-templates.mjs', import.meta.url));

test('migrateTemplate stamps inferred capabilities and is idempotent', () => {
  const template = {
    id: 'z-only',
    name: 'Z',
    canvas: { width: 1920, height: 1080, fps: 50 },
    layers: [{
      id: 'l1',
      type: 'rect',
      name: 'r',
      transform: { x: 0, y: 0, z: 4, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 },
    }],
    timeline: { directors: [], keyframes: [] },
  };
  const once = migrateTemplate(template);
  const twice = migrateTemplate(once);
  assert.ok(once.capabilities.includes('properties.position-z'));
  assert.deepEqual(once, twice);
  assert.equal(classifyTemplateCapabilities(once).airCompatible, true);
  assert.ok(!Object.is(once, template));
});

test('migrate-templates.mjs rewrites a copied db and refuses in-place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p22-migrate-'));
  try {
    const source = join(dir, 'source.db');
    const dest = join(dir, 'dest.db');
    const db = openDb(source);
    const dao = templatesDao(db);
    dao.create({
      id: 'plain',
      name: 'plain',
      data: {
        id: 'plain',
        name: 'plain',
        canvas: { width: 1920, height: 1080, fps: 50 },
        layers: [],
        timeline: { directors: [], actions: [], keyframes: [] },
      },
    });
    dao.create({
      id: 'z-only',
      name: 'Z',
      data: {
        id: 'z-only',
        name: 'Z',
        canvas: { width: 1920, height: 1080, fps: 50 },
        layers: [{
          id: 'l1',
          type: 'rect',
          name: 'r',
          transform: { x: 0, y: 0, z: 4, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 },
        }],
        timeline: { directors: [], keyframes: [] },
      },
    });
    db.close();

    const inPlace = spawnSync(process.execPath, [toolPath, source, source], { encoding: 'utf8' });
    assert.notEqual(inPlace.status, 0);
    assert.match(inPlace.stderr, /in place/i);

    const result = spawnSync(process.execPath, [toolPath, source, dest], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.templates, 2);
    assert.equal(summary.rewritten, 1);

    const migrated = openDb(dest);
    const migratedDao = templatesDao(migrated);
    assert.equal(migratedDao.get('plain').data.capabilities, undefined);
    assert.deepEqual(migratedDao.get('z-only').data.capabilities, ['properties.position-z']);
    migrated.close();

    const again = spawnSync(process.execPath, [toolPath, source, dest], { encoding: 'utf8' });
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /overwrite/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
