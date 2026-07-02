# Titulus Architecture

Titulus is a dual-plane broadcast graphics system:

- **Control plane**: authoring + operator workflow (`frontend` + `backend`)
- **Render plane**: per-channel native engine (`bg_engine`)

Render behavior is CasparCG-aligned (producer -> mixer -> consumer), implemented
as proprietary clean-room code.

## 1) High-level topology

```text
frontend (React/Vite)
  <-> backend (Express/WS/SQLite)
  <-> bg_engine (C++/CEF OSR, 1 process per channel)
  -> consumers: null | pipe | preview | decklink | stream
```

- Frontend routes: `/login`, `/templates`, `/editor/:id`, `/control`, `/settings`, `/renderer`
- Backend surface: `/api/*`, `/ws/control`, `/ws/renderer`, static (`/channel.html`, `/bg-runtime.js`, `/uploads`, `/fonts`)
- Engine loads `channel.html` and emits BGRA frames to one primary consumer.

## 2) Repository layout

```text
engine/    native render host + consumers + supervisor scripts
runtime/   shared TS render logic (@titulus/runtime)
backend/   API/WS/auth/billing/audit + SQLite + media pipeline
frontend/  operator/editor SPA
shared/    JSON schema contracts (template.schema.json)
bench/     performance harness
docs/      architecture, runbook, validation/handoff docs
```

## 3) Control plane

### 3.1 Backend core

- Node.js 20+, ESM, Express 4 + `express-ws`
- SQLite via `better-sqlite3` (WAL)
- Security headers baseline + structured error normalization (`INVALID_JSON`, `INTERNAL_ERROR`)

### 3.2 Auth / RBAC

- Token sessions (`users`, `sessions`, `tenants`)
- Roles: `admin`, `operator`
- Protected REST endpoints via auth middleware
- `/ws/control` requires valid auth token (query/header)

### 3.3 REST API groups

- Auth: `/api/auth/*` (`login`, `logout`, `me`, user management)
- Templates/channels/rundowns/settings
- On-air snapshot: `/api/onair`
- Upload pipeline: `/api/uploads`, `/api/uploads/jobs/:id`
- Licensing: `/api/license/*`
- Billing/entitlements: `/api/billing/entitlements`, `/api/billing/hook`
- Audit: `/api/audit/events`
- Health: `/api/health`

Rundown-specific routes:

- `GET /api/rundowns` + `GET /api/rundowns/:id`
- `POST /api/rundowns` / `PUT /api/rundowns/:id` / `DELETE /api/rundowns/:id`
- `POST /api/rundowns/reorder`

### 3.4 WebSocket hubs

- `/ws/control` - validated operator commands (`take/update/clear`)
- `/ws/renderer` - runtime subscriptions, replay-on-connect

### 3.5 Persistence

SQLite tables include:

- content/state: `templates`, `channels`, `rundowns`, `settings`, `on_air`
- licensing/auth: `license_state`, `users`, `sessions`, `tenants`
- observability/compliance: `audit_events`

`on_air.order_index` keeps deterministic replay order after backend restart.

### 3.6 Rundown mechanism v2 (slot-aware playout)

Rundown now acts as a scenario-oriented operator workflow:

- Each slot has stable identity `slotId` (separate from template id).
- Slot payload is canonical: `{ slotId, templateId, name, vars }`.
- On-air identity for rundown playout uses `slotId`, so one template can be taken
  multiple times in parallel through different slots.
- Backend DAO normalizes legacy slots (`id/label/variables`) to canonical shape
  automatically on read/write (soft migration, no manual DB migration step).

Control workflow inside `/control` Rundown tab:

- active rundown selection,
- slot CRUD/reorder + variable editing,
- transport PREV / TAKE / NEXT + hotkeys,
- live UPDATE for slot variables when slot is already on-air.

## 4) Shared runtime (`runtime/`)

`@titulus/runtime` is the single render implementation used by engine and editor.

Core modules:

- `schema.ts`, `timeline.ts`, `domRenderer.ts`, `channelClient.ts`
- `easing.ts`, `transform.ts`, `stackOrder.ts`, `clock.ts`, `fonts.ts`

Build output:

- `runtime/build.mjs` -> `backend/public/bg-runtime.js` (`window.BG`)

## 5) Render plane (`engine/`)

### 5.1 Engine host

- C++20 + CEF OSR
- CPU-only policy (`disable-gpu`, `disable-gpu-compositing`)
- BGRA end-to-end path
- One process = one channel = one primary output

### 5.2 Frame pipeline

```text
channel.html + bg-runtime.js
 -> CEF OnPaint (BGRA)
 -> frame ring
 -> consumer OnFrame()
```

Engine reports interval/fps/drop statistics via periodic logs and final `SUMMARY`. DeckLink consumer additionally reports 5s-window telemetry (`telemetry5s`: in/out fps, pairs/singles/starved field-pairing counters) and per-stage timing (`stages5s`: copy/weave/schedule microseconds, see `docs/phase11-baseline.md`).

**Clock model (Phase 11.2):** for DeckLink-driven channels, the render pump no longer free-runs its own timer — `Consumer::HasExternalClock()`/`WaitForTick()` let the DeckLink `ScheduledFrameCompleted` callback drive the pump directly, so the SDI card is the single clock for paint + JS timeline + output. Every other consumer (`null`/`pipe`/`preview`/`stream`, i.e. the Browser/OBS/vMix output path) keeps the original self-timer (`MessagePump`, 50Hz) path unchanged.

### 5.3 Consumers

- `null` (bench)
- `pipe` (raw BGRA debug)
- `preview` (JPEG monitor output)
- `decklink` — code-complete since Phase 3; substantial live hardware validation since Phase 10/11 on a DeckLink Quad 2 + genlock host (`docs/phase6-decklink-host-diagnose.md`, `docs/phase11-baseline.md`); formal 8h-soak closure (Phase 6.4) still pending
- `stream` (`ffmpeg_consumer`, SRT/RTMP/UDP)

### 5.4 Supervision

- `engine/run-engines.sh`:
  - fetches channel config from backend,
  - assigns CPU affinity,
  - launches one supervisor per channel,
  - supports auth-aware backend access.
- `engine/run-channel.sh` maps `output_mode` to consumer flags and restarts workers.

## 6) Template contract

Source of truth: `shared/template.schema.json`.

Key points:

- deterministic render payload structure,
- AI/operator metadata fields (`schemaVersion`, `description`, `tags`, `metadata`),
- strict variable/timeline validation,
- backend contract: `POST /api/templates/validate`.

## 7) Output modes

- `browser`
- `obs_vmix`
- `decklink`
- `stream`

Configured per channel via `/api/channels` and consumed by engine supervisors.

## 8) Operational profiles

- **Cloud SaaS**: browser/stream outputs + auth/billing/audit foundations
- **On-prem broadcast**: same codebase, DeckLink SDI path on hardware host

## 9) Reliability / performance constraints

- CPU-only rendering by default
- Per-channel process + CPU affinity isolation (SMT-aware pinning, Phase 10.3)
- Strict validation and bounded payload handling for REST/WS
- Upload/transcode robustness (MIME/extension checks, timeout/retry)
- Final SDI acceptance requires DeckLink + genlock host execution — substantial live evidence gathered on such a host since Phase 10 (`docs/phase6-decklink-host-diagnose.md`, `docs/phase11-baseline.md`); formal 8h-soak closure (Phase 6.4) still pending
- Rundown playout remains on the same `/ws/control` command path (no parallel WS protocol)
- `SCHED_FIFO` priority is opt-in and scoped: only DeckLink-driven channels request it (soft-fails without `CAP_SYS_NICE`/`RLIMIT_RTPRIO`); Browser/OBS/vMix output never requests real-time scheduling (Phase 11.4)

