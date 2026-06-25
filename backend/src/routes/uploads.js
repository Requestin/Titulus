// backend/src/routes/uploads.js
//
// Media upload REST (DEVELOPMENT_PROMPT §7.3 / §7.5).
//
//   POST /api/uploads          multipart "file" -> { jobId, status, url, posterUrl, type }
//   GET  /api/uploads/jobs/:id  transcode job status (poll until status === 'ready')
//
// Security (security-review): uuid filenames (no client-controlled paths → no
// traversal), MIME allow-list, 200 MB cap. Files land in the data uploads dir
// and are served read-only from /uploads.

import { Router } from 'express';
import multer from 'multer';
import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mediaTypeFor } from '../media.js';

const MAX_BYTES = 200 * 1024 * 1024; // 200 MB (§7.5)

export function uploadsRouter(media, uploadsDir) {
  const router = Router();

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      // Keep only a safe extension; the name itself is a fresh uuid.
      const ext = (extname(file.originalname) || '').toLowerCase().replace(/[^.a-z0-9]/g, '');
      cb(null, `${randomUUID()}${ext}`);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: MAX_BYTES },
    fileFilter: (req, file, cb) => {
      if (mediaTypeFor(file.mimetype) === null) {
        const err = new Error(`unsupported media type: ${file.mimetype}`);
        err.code = 'UNSUPPORTED_TYPE';
        return cb(err);
      }
      cb(null, true);
    },
  });

  router.post('/', (req, res) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'file too large (max 200 MB)' });
        if (err.code === 'UNSUPPORTED_TYPE') return res.status(415).json({ error: err.message });
        return res.status(400).json({ error: err.message || 'upload failed' });
      }
      if (!req.file) return res.status(400).json({ error: 'multipart field "file" required' });
      const job = media.ingest(req.file);
      res.status(201).json({
        jobId: job.id, status: job.status, url: job.url, posterUrl: job.posterUrl, type: job.type,
      });
    });
  });

  router.get('/jobs/:id', (req, res) => {
    const job = media.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'job not found' });
    res.json(job);
  });

  return router;
}
