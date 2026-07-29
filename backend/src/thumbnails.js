// backend/src/thumbnails.js
//
// Persist template preview JPEGs under $TITULUS_DATA/thumbnails/{id}.jpg.
// Generation happens in the editor (DOM mid-timeline capture) and is uploaded
// via PUT /api/templates/:id/thumbnail. This module owns paths + static URL.

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function thumbnailsDir(dataDir) {
  const dir = resolve(dataDir, 'thumbnails');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function thumbnailFilePath(dataDir, templateId) {
  return join(thumbnailsDir(dataDir), `${templateId}.jpg`);
}

export function thumbnailPublicUrl(templateId, cacheBust) {
  const q = cacheBust ? `?v=${encodeURIComponent(String(cacheBust))}` : '';
  return `/thumbnails/${templateId}.jpg${q}`;
}

export function thumbnailExists(dataDir, templateId) {
  return existsSync(thumbnailFilePath(dataDir, templateId));
}

/** Write JPEG bytes (Buffer) for a template id. */
export function saveThumbnailJpeg(dataDir, templateId, jpegBuffer) {
  const path = thumbnailFilePath(dataDir, templateId);
  writeFileSync(path, jpegBuffer);
  return thumbnailPublicUrl(templateId, Date.now());
}

export function removeThumbnail(dataDir, templateId) {
  const path = thumbnailFilePath(dataDir, templateId);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* ignore */
  }
}

/** Decode a data-URL or raw base64 JPEG/PNG into a Buffer. */
export function decodeImagePayload(body) {
  if (!body || typeof body !== 'object') return null;
  const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : null;
  const b64 = typeof body.base64 === 'string' ? body.base64 : null;
  const raw = dataUrl || b64;
  if (!raw) return null;
  const m = /^data:image\/(?:jpeg|jpg|png);base64,(.+)$/i.exec(raw);
  const payload = m ? m[1] : (dataUrl ? null : raw);
  if (!payload) return null;
  try {
    return Buffer.from(payload, 'base64');
  } catch {
    return null;
  }
}
