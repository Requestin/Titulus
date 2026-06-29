# Titulus Architecture

Titulus is a cloud broadcast graphics system with two planes:

- **Control plane**: template editing, operator control, channels/rundowns/settings, REST + WebSocket.
- **Render plane**: one `bg_engine` process per channel, CEF OSR render, pluggable output consumers.

The architecture follows CasparCG channel semantics (producer -> mixer -> consumer), but is implemented as proprietary clean-room code.

## 1. High-Level Topology

```text
frontend (React/Vite) <-> backend (Express/WS/SQLite) <-> bg_engine (C++/CEF)
                                                       -> consumers: null|pipe|preview|decklink|stream
```

- `frontend` provides `/templates`, `/editor/:id`, `/control`, `/settings`, `/renderer`.
- `backend` provides REST (`/api/*`), WS (`/ws/control`, `/ws/renderer`), and static assets (`/channel.html`, `/bg-runtime.js`, `/uploads`, `/fonts`).
- `bg_engine` loads `channel.html` in CEF OSR and pushes BGRA frames to one primary consumer per channel.

## 2. Repository Layout

```text
engine/    C++ render host + consumers + supervisor scripts
runtime/   shared TS render logic (@titulus/runtime)
backend/   Node.js API/WS + SQLite + media pipeline
frontend/  React SPA (editor/control/settings)
shared/    JSON schema contracts (template.schema.json)
bench/     performance harness
docs/      architecture, runbook, benchmark artifacts
```

## 3. Control Plane

### 3.1 Backend (`backend/src/index.js`)

- Node.js 20+, ESM, Express 4 + `express-ws`.
- SQLite via `better-sqlite3` (WAL).
- Security baseline headers:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: SAMEORIGIN`
  - `Referrer-Policy: no-referrer`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- Error normalization:
  - `400 INVALID_JSON` for malformed JSON body.
  - `500 INTERNAL_ERROR` fallback for unhandled failures.

### 3.2 REST API

- `/api/templates` CRUD, `/api/templates/schema`, `/api/templates/validate`
- `/api/channels` CRUD (supports `output_mode`, `device_index`, `display_mode`, `keyer_mode`, `stream_url`)
- `/api/rundowns` CRUD/reorder
- `/api/uploads` + `/api/uploads/jobs/:id` media ingest/transcode lifecycle
- `/api/onair` current on-air snapshot
- `/api/settings` global settings blob
- `/api/health` health probe

### 3.3 WebSocket Hubs

- `/ws/control`: operator commands (`take`, `update`, `clear`), payload validation, size cap, structured WS errors.
- `/ws/renderer`: channel runtime connections for replay-on-connect and live fan-out.

### 3.4 Persistence Model

- `templates`, `channels`, `rundowns`, `settings`, `on_air` in SQLite.
- `on_air.order_index` preserves deterministic replay order after backend restart.
- Upload artifacts are stored under `${TITULUS_DATA}/uploads`.

## 4. Shared Runtime (`runtime/`)

`@titulus/runtime` is the single render-logic implementation used by:

- engine runtime page (`backend/public/channel.html`)
- frontend editor preview (WYSIWYG parity)
- future thumbnail/auxiliary render paths

Main modules:

- `schema.ts`: canonical domain types
- `timeline.ts`: directors/keyframes/actions playback model
- `domRenderer.ts`: JSON template -> DOM scene graph
- `channelClient.ts`: WS client (`take/update/clear`) + replay behavior
- `easing.ts`, `transform.ts`, `stackOrder.ts`, `clock.ts`, `fonts.ts`

Build output:

- `runtime/build.mjs` bundles to `backend/public/bg-runtime.js` (IIFE, `window.BG`).

## 5. Render Plane (`engine/`)

### 5.1 Engine Host

- C++20 + CEF OSR (`engine_app.*`, `engine_client.*`, `main.cpp`).
- CPU-only policy (`disable-gpu`, `disable-gpu-compositing`, headless ozone path).
- One process = one channel = one primary consumer.
- BGRA end-to-end from CEF `OnPaint` to consumer input.

### 5.2 Frame Pipeline

```text
channel.html + bg-runtime.js
 -> CEF OSR paint (BGRA)
 -> frame ring (latest-frame handoff)
 -> consumer OnFrame()
```

Stats are emitted as periodic progress + final `SUMMARY` line (`frames`, `fps`, p50/p99/p999 interval, late/drops).

### 5.3 Consumers

- `null`: benchmark/discard
- `pipe`: raw BGRA output for debug
- `preview`: JPEG snapshots for monitoring
- `decklink`: SDI Fill+Key (code-complete, hardware validation deferred without board/genlock)
- `stream` (`ffmpeg_consumer`): BGRA rawvideo -> ffmpeg child via stdin -> SRT/RTMP/UDP output

### 5.4 Channel Supervision

- `engine/run-engines.sh`: fetches channels from backend, assigns per-channel CPU affinity, launches one supervisor per channel.
- `engine/run-channel.sh`: maps `output_mode` -> consumer flags and restarts channel process after exit.

## 6. Template Contract (AI-Ready)

Source of truth: `shared/template.schema.json`.

Key properties:

- Deterministic render payload (`canvas`, `variables`, `groups`, `layers`, stacks, timeline).
- AI/operator metadata extensions (`schemaVersion`, `description`, `tags`, `metadata`).
- Stronger validation for timeline/action payload shapes and type-aware variable defaults.
- Backend validation endpoint: `POST /api/templates/validate`.

## 7. Output Modes

Per-channel `output_mode`:

- `browser`: preview via browser route
- `obs_vmix`: Browser Source mode via `channel.html`
- `decklink`: SDI output via DeckLink consumer
- `stream`: network stream via ffmpeg consumer (`stream_url`)

## 8. Deployment Profiles

- **Cloud SaaS**: control plane + stream/browser outputs.
- **On-prem broadcast**: same codebase, DeckLink SDI enabled when hardware is present.

## 9. Reliability and Performance Constraints

- CPU-only render path by default.
- Channel isolation with dedicated cores (`taskset`).
- Upload/transcode robustness: strict MIME + extension checks, retry/timeout semantics.
- Structured error contracts for REST and WS control paths.
- Validation on bare-metal + genlock required for final SDI acceptance.

