import { Router } from 'express';
import multer from 'multer';
import { dataFilesDao } from '../db.js';
import {
  ALLOWED_DATA_MIMES,
  MAX_DATA_FILE_BYTES,
  readAllowedText,
  writeManagedDataFile,
} from '../filesAccess.js';

function apiError(res, error) {
  const status = error.status || 400;
  return res.status(status).json({
    error: {
      code: error.code || 'FILE_ERROR',
      message: error.message || 'file error',
    },
  });
}

export function filesRouter({ db, dataDir, env = process.env }) {
  const router = Router();
  const dao = dataFilesDao(db);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_DATA_FILE_BYTES },
    fileFilter: (req, file, cb) => {
      if (file.mimetype && !ALLOWED_DATA_MIMES.has(file.mimetype)) {
        const err = new Error('unsupported media type');
        err.code = 'UNSUPPORTED_MEDIA_TYPE';
        err.status = 415;
        return cb(err);
      }
      cb(null, true);
    },
  });

  router.get('/', (req, res) => {
    res.json(dao.all());
  });

  router.post('/read', (req, res) => {
    const pathIn = typeof req.body?.path === 'string' ? req.body.path : '';
    try {
      const result = readAllowedText(pathIn, { dataDir, env });
      return res.json(result);
    } catch (error) {
      return apiError(res, error);
    }
  });

  router.post('/', (req, res) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return apiError(res, { status: 413, code: 'FILE_TOO_LARGE', message: 'file too large' });
        }
        return apiError(res, err);
      }
      if (!req.file) {
        return apiError(res, { status: 400, code: 'FILE_REQUIRED', message: 'multipart field "file" required' });
      }
      try {
        const stored = writeManagedDataFile(req.file.buffer, req.file.originalname, { dataDir });
        const row = dao.insert({
          id: stored.id,
          original_name: stored.originalName,
          stored_name: stored.storedName,
          mime: req.file.mimetype || 'text/plain',
          size_bytes: stored.size,
        });
        return res.status(201).json({
          id: row.id,
          name: row.original_name,
          path: stored.path,
          size: row.size_bytes,
          mime: row.mime,
        });
      } catch (error) {
        return apiError(res, error);
      }
    });
  });

  return router;
}
