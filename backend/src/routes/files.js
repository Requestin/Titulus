// backend/src/routes/files.js
//
// Read allow-listed .txt files for Crawl Use File / Parse (local or Samba mounts).

import { Router } from 'express';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, extname, normalize } from 'node:path';

function apiError(res, status, code, message, details) {
  return res.status(status).json({
    error: { code, message, details: details || null },
  });
}

function fileRoots() {
  const raw = process.env.TITULUS_FILE_ROOTS || '';
  const data = process.env.TITULUS_DATA || '/var/lib/titulus';
  const parts = raw.split(':').map((s) => s.trim()).filter(Boolean);
  const roots = [resolve(data), ...parts.map((p) => resolve(p))];
  return [...new Set(roots)];
}

function isUnderRoot(absPath, roots) {
  const norm = normalize(absPath);
  return roots.some((root) => {
    const r = normalize(root);
    return norm === r || norm.startsWith(r.endsWith('/') ? r : `${r}/`);
  });
}

export function filesRouter() {
  const router = Router();

  router.post('/read', (req, res) => {
    const pathIn = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
    if (!pathIn) {
      return apiError(res, 400, 'PATH_REQUIRED', 'path required');
    }
    if (pathIn.includes('\0')) {
      return apiError(res, 400, 'INVALID_PATH', 'invalid path');
    }

    const abs = resolve(pathIn);
    const roots = fileRoots();
    if (!isUnderRoot(abs, roots)) {
      return apiError(res, 403, 'PATH_NOT_ALLOWED', 'path is outside allowed roots', {
        roots,
      });
    }

    if (!existsSync(abs)) {
      return apiError(res, 404, 'FILE_NOT_FOUND', 'File not found');
    }

    let st;
    try {
      st = statSync(abs);
    } catch {
      return apiError(res, 404, 'FILE_NOT_FOUND', 'File not found');
    }
    if (!st.isFile()) {
      return apiError(res, 400, 'NOT_A_FILE', 'path is not a file');
    }

    const ext = extname(abs).toLowerCase();
    if (ext !== '.txt' && ext !== '.json') {
      return apiError(
        res,
        415,
        'UNSUPPORTED_FORMAT',
        'File format is not supported, supported only txt or json',
      );
    }

    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      return apiError(res, 404, 'FILE_NOT_FOUND', 'File not found');
    }

    // Reject obvious binary / non-text (NUL bytes).
    if (text.includes('\0')) {
      return apiError(
        res,
        415,
        'UNSUPPORTED_FORMAT',
        'File format is not supported, supported only txt or json',
      );
    }

    const lines = text.replace(/\r\n/g, '\n').split('\n');
    return res.json({ text, lines });
  });

  return router;
}
