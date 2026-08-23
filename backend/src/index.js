// backend/src/index.js
//
// Titulus control-plane entry point (DEVELOPMENT_PROMPT §7).
// Express + express-ws + better-sqlite3. Serves the REST API, the WebSocket
// hubs (/ws/control, /ws/renderer), the engine channel page + runtime bundle,
// and uploaded media.
//
// This module wires REST + WS + static assets for the control plane.

import express from 'express';
import expressWs from 'express-ws';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

import { openDb, settingsDao } from './db.js';
import { createAuth } from './auth.js';
import { createAudit } from './audit.js';
import { OnAirManager } from './onair.js';
import { prepareTemplate } from './prepareTemplate.js';
import { MediaJobs } from './media.js';
import { authRouter } from './routes/auth.js';
import { auditRouter } from './routes/audit.js';
import { billingRouter } from './routes/billing.js';
import { templatesRouter } from './routes/templates.js';
import { channelsRouter } from './routes/channels.js';
import { rundownsRouter } from './routes/rundowns.js';
import { uploadsRouter } from './routes/uploads.js';
import { filesRouter } from './routes/files.js';
import { mediaLibraryRouter } from './routes/media.js';
import { templateFoldersRouter } from './routes/templateFolders.js';
import { dataElementsRouter } from './routes/dataElements.js';
import { ensureDataFilesDir } from './filesAccess.js';
import { licenseRouter } from './routes/license.js';
import { wsRouter } from './routes/ws.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const PUBLIC_DIR = resolve(here, '../public');
// Data dir (app.db + uploads) is configurable so deployments can point it at a
// persisted volume (e.g. /var/lib/titulus) and tests at tmpfs.
const DATA_DIR = process.env.TITULUS_DATA
  ? resolve(process.env.TITULUS_DATA)
  : resolve(ROOT, 'data');
const UPLOADS_DIR = resolve(DATA_DIR, 'uploads');

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';
const UPLOADS_CORS_ORIGINS = (process.env.TITULUS_UPLOADS_CORS_ORIGINS || '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

function uploadsCors(req, res, next) {
  const origin = req.headers.origin;
  if (!origin || UPLOADS_CORS_ORIGINS.length === 0) return next();
  const allowAny = UPLOADS_CORS_ORIGINS.includes('*');
  const allowed = allowAny || UPLOADS_CORS_ORIGINS.includes(origin);
  if (!allowed) return next();
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Origin', allowAny ? '*' : origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
}

// ---------------------------------------------------------------------------
// App + DB
// ---------------------------------------------------------------------------
const app = express();
expressWs(app); // adds app.ws() and upgrades handling

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(express.json({ limit: '50mb' }));

const db = openDb(resolve(DATA_DIR, 'app.db'));
mkdirSync(UPLOADS_DIR, { recursive: true });
ensureDataFilesDir(DATA_DIR);
const THUMBNAILS_DIR = resolve(DATA_DIR, 'thumbnails');
mkdirSync(THUMBNAILS_DIR, { recursive: true });

app.locals.db = db;
const auth = createAuth(db);
app.locals.auth = auth;
const audit = createAudit(db);
app.locals.audit = audit;
const onAir = new OnAirManager(db, {
  prepare: (template, ctx) => prepareTemplate(template, { ...ctx, dataDir: DATA_DIR, db, env: process.env }),
});
app.locals.onAir = onAir;
const media = new MediaJobs(db, UPLOADS_DIR);
app.locals.media = media;

// ---------------------------------------------------------------------------
// REST: templates / channels / rundowns / settings (§7.3).
// ---------------------------------------------------------------------------
app.use('/api', audit.appendAudit);
app.use('/api/auth', authRouter(auth));
app.use('/api/billing', billingRouter(db, auth));
app.use('/api/audit', auth.requireAuth, auth.requireRole('admin'), auditRouter(audit));
app.use('/api/templates', auth.requireAuth, templatesRouter(db, { dataDir: DATA_DIR }));
app.use('/api/channels', auth.requireAuth, auth.requireRole('admin'), channelsRouter(db));
app.use('/api/rundowns', auth.requireAuth, rundownsRouter(db));
app.use('/api/uploads', auth.requireAuth, uploadsCors, uploadsRouter(media, UPLOADS_DIR));
app.use('/api/files', auth.requireAuth, auth.requirePermission('files.read'), filesRouter({ db, dataDir: DATA_DIR }));
app.use('/api/media', auth.requireAuth, mediaLibraryRouter({ db, media, uploadsDir: UPLOADS_DIR }));
app.use('/api/template-folders', auth.requireAuth, templateFoldersRouter(db));
app.use('/api/data-elements', auth.requireAuth, dataElementsRouter(db));
app.use('/api/license', auth.requireAuth, auth.requireRole('admin'), licenseRouter(db));

// On-air snapshot for the control panel (§7.4). Separate from the WS router so
// it sits under /api alongside the other REST endpoints.
app.get('/api/onair', auth.requireAuth, (req, res) => res.json(onAir.onAirTemplateIds()));
app.get('/api/onair/details', auth.requireAuth, (req, res) => res.json(onAir.onAirDetails()));

// WebSocket hubs (§7.4): /ws/control (panel -> backend), /ws/renderer (engine).
app.use('/ws', wsRouter(onAir, auth));

// Settings: global key-value fallback (GET all / PUT replace).
app.get('/api/settings', auth.requireAuth, (req, res) => res.json(settingsDao(db).all()));
app.put('/api/settings', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'settings object required' });
  }
  res.json(settingsDao(db).setAll(req.body));
});

// Health check.
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'titulus-backend' }));

// ---------------------------------------------------------------------------
// Static: engine channel page, runtime bundle, fonts, uploads.
// Channel.html + bg-runtime.js come from backend/public (Vite proxies in dev).
// ---------------------------------------------------------------------------
app.use('/thumbnails', express.static(THUMBNAILS_DIR, {
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=3600');
  },
}));
app.use('/uploads', uploadsCors, express.static(UPLOADS_DIR, {
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  },
}));
app.use('/fonts', express.static(resolve(ROOT, 'fonts')));
app.use(express.static(PUBLIC_DIR)); // channel.html, bg-runtime.js

// Normalize JSON parser failures and unexpected handler errors into API-safe
// payloads (instead of default HTML error pages).
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: {
        code: 'INVALID_JSON',
        message: 'invalid JSON body',
      },
    });
  }
  return next(err);
});

app.use((err, req, res, next) => {
  if (!err) return next();
  console.error('[titulus-backend] unhandled error', err);
  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'internal server error',
    },
  });
});

// ---------------------------------------------------------------------------
// Listen
// ---------------------------------------------------------------------------
const server = app.listen(PORT, HOST, () => {
  console.log(`[titulus-backend] listening on http://${HOST}:${PORT}`);
  console.log(`[titulus-backend] db: ${resolve(DATA_DIR, 'app.db')}`);
});

export { app, server, db };
