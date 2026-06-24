// backend/src/index.js
//
// Titulus control-plane entry point (DEVELOPMENT_PROMPT §7).
// Express + express-ws + better-sqlite3. Serves the REST API, the WebSocket
// hubs (/ws/control, /ws/renderer), the engine channel page + runtime bundle,
// and uploaded media.
//
// WS + on-air wiring lands in task 2.3; this first cut mounts the templates
// REST API + static serving so the control plane is reachable end-to-end.

import express from 'express';
import expressWs from 'express-ws';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

import { openDb } from './db.js';
import { templatesRouter } from './routes/templates.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const PUBLIC_DIR = resolve(here, '../public');
const DATA_DIR = resolve(ROOT, 'data');
const UPLOADS_DIR = resolve(DATA_DIR, 'uploads');

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';

// ---------------------------------------------------------------------------
// App + DB
// ---------------------------------------------------------------------------
const app = express();
expressWs(app); // adds app.ws() and upgrades handling

app.use(express.json({ limit: '50mb' }));

const db = openDb(resolve(DATA_DIR, 'app.db'));
mkdirSync(UPLOADS_DIR, { recursive: true });

app.locals.db = db;

// ---------------------------------------------------------------------------
// REST: templates (task 2.1). Channels/rundowns land in 2.2.
// ---------------------------------------------------------------------------
app.use('/api/templates', templatesRouter(db));

// Health check.
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'titulus-backend' }));

// ---------------------------------------------------------------------------
// Static: engine channel page, runtime bundle, fonts, uploads.
// Channel.html + bg-runtime.js come from backend/public (Vite proxies in dev).
// ---------------------------------------------------------------------------
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/fonts', express.static(resolve(ROOT, 'fonts')));
app.use(express.static(PUBLIC_DIR)); // channel.html, bg-runtime.js

// ---------------------------------------------------------------------------
// Listen
// ---------------------------------------------------------------------------
const server = app.listen(PORT, HOST, () => {
  console.log(`[titulus-backend] listening on http://${HOST}:${PORT}`);
  console.log(`[titulus-backend] db: ${resolve(DATA_DIR, 'app.db')}`);
});

// Channels/rundowns/WS/media routers will be mounted here in tasks 2.2-2.4 via
// additional app.use(...) calls (kept out of this file's top level to land per-task).

export { app, server, db };
