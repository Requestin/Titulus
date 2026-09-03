import { existsSync, unlinkSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { createId } from '../id.js';

const FONT_EXTENSIONS = new Set(['.woff2', '.woff', '.ttf', '.otf']);

export function fontsDao(db, fontsDir) {
  mkdirSync(fontsDir, { recursive: true });

  function rowToFont(row) {
    if (!row) return null;
    return {
      id: row.id,
      family: row.family,
      weight: row.weight,
      style: row.style,
      filePath: row.file_path,
      originalName: row.original_name,
      title: row.title,
      locked: Boolean(row.locked),
      url: `/fonts/${row.file_path}`,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  return {
    list() {
      const rows = db.prepare('SELECT * FROM font_assets ORDER BY family, weight').all();
      return rows.map(rowToFont);
    },

    get(id) {
      const row = db.prepare('SELECT * FROM font_assets WHERE id = ?').get(id);
      return rowToFont(row);
    },

    getByFamily(family) {
      const rows = db.prepare('SELECT * FROM font_assets WHERE family = ?').all(family);
      return rows.map(rowToFont);
    },

    create({ family, weight = 'normal', style = 'normal', filePath, originalName, title = '' }) {
      const id = createId();
      db.prepare(
        `INSERT INTO font_assets (id, family, weight, style, file_path, original_name, title)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, family, weight, style, filePath, originalName, title);
      return this.get(id);
    },

    update(id, { title, locked }) {
      const sets = [];
      const params = [];
      if (title !== undefined) { sets.push('title = ?'); params.push(title); }
      if (locked !== undefined) { sets.push('locked = ?'); params.push(locked ? 1 : 0); }
      if (sets.length === 0) return this.get(id);
      params.push(id);
      db.prepare(`UPDATE font_assets SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...params);
      return this.get(id);
    },

    remove(id) {
      const font = this.get(id);
      if (!font) return false;
      if (font.locked) return false;
      const filePath = join(fontsDir, font.filePath);
      if (existsSync(filePath)) unlinkSync(filePath);
      db.prepare('DELETE FROM font_assets WHERE id = ?').run(id);
      return true;
    },

    /** Scan fontsDir for new font files not yet in the DB and import them. */
    refreshFolder() {
      const known = new Set(
        db.prepare('SELECT file_path FROM font_assets').all().map((row) => row.file_path),
      );
      const imported = [];
      const files = readdirSync(fontsDir);
      for (const file of files) {
        const ext = extname(file).toLowerCase();
        if (!FONT_EXTENSIONS.has(ext)) continue;
        if (known.has(file)) continue;
        const family = basename(file, ext);
        try {
          const font = this.create({
            family,
            filePath: file,
            originalName: file,
            title: family,
          });
          imported.push(font);
        } catch (e) {
          // skip duplicates or errors
        }
      }
      return imported;
    },

    /** Generate @font-face CSS for all registered fonts. */
    cssManifest() {
      const fonts = this.list();
      const rules = fonts.map((font) => {
        const weight = font.weight || 'normal';
        const style = font.style || 'normal';
        return `@font-face {
  font-family: "${font.family}";
  font-weight: ${weight};
  font-style: ${style};
  src: url("/fonts/${font.filePath}") format("${formatForExt(extname(font.filePath))}");
}`;
      });
      return rules.join('\n\n');
    },
  };
}

function formatForExt(ext) {
  switch (ext.toLowerCase()) {
    case '.woff2': return 'woff2';
    case '.woff': return 'woff';
    case '.ttf': return 'truetype';
    case '.otf': return 'opentype';
    default: return 'truetype';
  }
}
