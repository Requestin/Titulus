// backend/src/routes/uploads.js
//
// Media upload REST (DEVELOPMENT_PROMPT §7.3 / §7.5).
//
//   POST /api/uploads          multipart "file" -> { jobId, status, url, posterUrl, type }
//   GET  /api/uploads/jobs/:id  transcode job status (poll until status === 'ready')
//
// Security (security-review): uuid filenames (no client-controlled paths → no
// traversal), MIME allow-list, 200 MB cap. Files land in uploads/images or
// uploads/video and are served read-only from /uploads.

import { Router } from 'express';
import multer from 'multer';
import { mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mediaKindDir, mediaTypeFor } from '../media.js';

const MAX_BYTES = 200 * 1024 * 1024; // 200 MB (§7.5)
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm']);

function apiError(res, status, code, message, details) {
  return res.status(status).json({
    error: { code, message, details: details || null },
  });
}

export function uploadsRouter(media, uploadsDir) {
  const router = Router();

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const kind = mediaTypeFor(file.mimetype) || 'image';
      const sub = mediaKindDir(kind) || 'images';
      const dest = join(uploadsDir, sub);
      mkdirSync(dest, { recursive: true });
      cb(null, dest);
    },
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
      const kind = mediaTypeFor(file.mimetype);
      if (kind === null) {
        const err = new Error(`unsupported media type: ${file.mimetype}`);
        err.code = 'UNSUPPORTED_TYPE';
        return cb(err);
      }
      const ext = (extname(file.originalname) || '').toLowerCase();
      const allowedExt = kind === 'image' ? IMAGE_EXT : VIDEO_EXT;
      if (!allowedExt.has(ext)) {
        const err = new Error(`unsupported file extension: ${ext || '(none)'}`);
        err.code = 'UNSUPPORTED_EXTENSION';
        return cb(err);
      }
      cb(null, true);
    },
  });

  // CORS preflight for cross-origin upload clients if enabled in index.js.
  router.options('*', (req, res) => res.status(204).end());

  router.post('/', (req, res) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return apiError(res, 413, 'FILE_TOO_LARGE', 'file too large (max 200 MB)');
        }
        if (err.code === 'UNSUPPORTED_TYPE') {
          return apiError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', err.message);
        }
        if (err.code === 'UNSUPPORTED_EXTENSION') {
          return apiError(res, 415, 'UNSUPPORTED_EXTENSION', err.message);
        }
        return apiError(res, 400, 'UPLOAD_FAILED', err.message || 'upload failed');
      }
      if (!req.file) {
        return apiError(res, 400, 'FILE_REQUIRED', 'multipart field "file" required');
      }
      const kind = mediaTypeFor(req.file.mimetype);
      const sub = mediaKindDir(kind) || 'images';
      req.file.relativeName = `${sub}/${req.file.filename}`;
      const job = media.ingest(req.file);
      const statusCode = job.status === 'error' ? 422 : 201;
      res.status(statusCode).json({
        jobId: job.id, status: job.status, url: job.url, posterUrl: job.posterUrl, type: job.type,
        profile: job.profile ?? null, hasAlpha: job.hasAlpha ?? false,
        error: job.error || null,
      });
    });
  });

  router.get('/jobs/:id', (req, res) => {
    const job = media.get(req.params.id);
    if (!job) return apiError(res, 404, 'JOB_NOT_FOUND', 'job not found');
    res.json(job);
  });

  return router;
}
