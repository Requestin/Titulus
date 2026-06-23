# `backend/` — control plane API + WebSocket hub (DEVELOPMENT_PROMPT §7)

Node.js 20+, Express + express-ws, better-sqlite3 (WAL), multer, ajv.

- `src/` — `index.js` (WS routing, on-air state), `db.js` (SQLite + DAOs),
  `media.js` (ffmpeg VP9/WebM alpha transcode), `templateValidation.js`, `routes/`
- `public/` — `channel.html` (engine/browser renderer page), `bg-runtime.js` (built, gitignored)

Populated in **Phase 1** (channel page) and **Phase 2** (REST + WS). Not yet implemented.
