import { Router } from 'express';
import multer from 'multer';
import { extname, basename } from 'node:path';
import { createId } from '../id.js';
import { fontsDao } from '../fontLibrary.js';

const FONT_EXTENSIONS = new Set(['.woff2', '.woff', '.ttf', '.otf']);

export function fontsRouter({ db, fontsDir }) {
  const router = Router();
  const dao = fontsDao(db, fontsDir);
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, fontsDir),
      filename: (req, file, cb) => {
        const ext = extname(file.originalname).toLowerCase();
        const safeBase = basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '-');
        cb(null, `${safeBase}${ext}`);
      },
    }),
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ext = extname(file.originalname).toLowerCase();
      if (FONT_EXTENSIONS.has(ext)) return cb(null, true);
      cb(new Error(`Unsupported font format: ${ext}`));
    },
  });

  router.get('/', (req, res) => {
    res.json(dao.list());
  });

  router.get('/manifest.css', (req, res) => {
    res.set('Content-Type', 'text/css');
    res.set('Cache-Control', 'no-cache');
    res.send(dao.cssManifest());
  });

  router.post('/', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: { code: 'FILE_REQUIRED', message: 'font file required' } });
    const family = req.body.family || basename(req.file.filename, extname(req.file.filename));
    const weight = req.body.weight || 'normal';
    const style = req.body.style || 'normal';
    const title = req.body.title || family;
    const font = dao.create({
      family,
      weight,
      style,
      filePath: req.file.filename,
      originalName: req.file.originalname,
      title,
    });
    res.status(201).json(font);
  });

  router.put('/:id', (req, res) => {
    const { title, locked } = req.body ?? {};
    const font = dao.update(req.params.id, { title, locked });
    if (!font) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'font not found' } });
    res.json(font);
  });

  router.delete('/:id', (req, res) => {
    const ok = dao.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'font not found or locked' } });
    res.json({ ok: true });
  });

  router.post('/refresh', (req, res) => {
    const imported = dao.refreshFolder();
    res.json({ imported });
  });

  return router;
}
