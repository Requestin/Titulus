# Фаза 2 — Control plane + output modes

## Мета

| Поле | Значение |
|---|---|
| **Статус** | DONE |
| **PR** | #14–#23 |
| **Merge** | июнь 2025–2026 |
| **Exit PR** | #24 (Phase 2 exit marker) |

---

## 1. Цель / зачем

Полный **operator workflow**: авторинг шаблонов, TAKE/UPDATE/CLEAR, per-channel output selection, **on-air переживает рестарт backend** (NFR-1).

Control plane — собственный продукт (не AMCP, не CasparCG Client).

---

## 2. Исходное состояние

- Phase 1: `@titulus/runtime`, `channel.html`, `bg_engine` end-to-end
- Нет backend, editor, WS, persistence
- Нет media pipeline, supervisor

---

## 3. Scope

| # | Deliverable |
|---|---|
| 2.1 | SQLite + Express + templates REST + ajv |
| 2.2 | Channels, rundowns, settings REST |
| 2.3 | WS hubs + on-air persistence + `/api/onair` |
| 2.4 | Media transcode VP9/WebM alpha + uploads |
| 2.5 | Frontend shell (Vite/React/TS/Tailwind) |
| 2.6 | Template editor WYSIWYG + timeline |
| 2.7 | Control panel TAKE/UPDATE/CLEAR + Program Monitor |
| 2.8 | Output modes Settings + `run-engines.sh` supervisor |

---

## 4. Реализация

### Backend

- `backend/src/db.js` — WAL SQLite, DAO factory pattern
- Routes: `/api/templates`, `/api/channels`, `/api/rundowns`, `/api/settings`, `/api/uploads`
- `OnAirManager` (`onair.js`): in-memory + SQLite `on_air`, replay-on-connect
- WS: `/ws/control`, `/ws/renderer?channel=<id>`
- `TITULUS_DATA` — конфигурируемый data path

### Media

- `backend/src/media.js` — ffmpeg VP9/WebM alpha, poster, retry/timeout
- Multer uploads, MIME validation

### Frontend

- React 18 + Zustand + zundo, dark design system (`docs/PRODUCT.md`, `docs/DESIGN.md`)
- Editor: `CanvasArea` через `@titulus/runtime` — WYSIWYG
- Control: Templates | Rundowns, Program Monitor iframe, Browser Source URL
- Settings: channel CRUD, output mode per channel

### Supervisor

- `engine/run-engines.sh` — читает channel config с API, taskset pinning
- `engine/run-channel.sh` — per-channel loop, restart on exit 42
- `dev-start.sh` / `dev-stop.sh` — full dev stack

### WS protocol

```json
{ "type": "take|update|clear", "templateId", "channelId", "template?", "variables?" }
```

Renderer replay on connect — все active takes для channel.

---

## 5. PR / Git

| # | Title | Ключевые файлы |
|---|---|---|
| 14 | [Phase 2] SQLite + Express core + templates REST | `backend/src/` |
| 15 | [Phase 2] channels + rundowns + settings REST | `routes/channels.js`, `rundowns.js` |
| 17 | [Phase 2] WS hubs + on-air persistence | `onair.js`, `routes/ws.js` |
| 18 | [Phase 2] media transcode + uploads | `media.js`, `routes/uploads.js` |
| 19 | [Phase 2] frontend shell | `frontend/src/` |
| 20 | [Phase 2] template editor core | `features/editor/` |
| 21 | [Phase 2] full timeline editor | Timeline, curve editor |
| 22 | [Phase 2] operator control panel | `ControlPage` |
| 23 | [Phase 2] output modes + run-engines.sh | Settings, `run-engines.sh` |

---

## 6. Проверка

```bash
# Backend + WS smoke (TITULUS_DATA=/tmp/...)
cd backend && PORT=3002 TITULUS_DATA=/tmp/titulus-test node src/index.js

# Supervisor dry-run
./engine/run-engines.sh --dry-run

# Kill backend → restart → on-air restored
curl http://127.0.0.1:3002/api/onair
```

Operator loop: TAKE → UPDATE (debounced) → CLEAR → CLEAR ALL fan-out.

---

## 7. Результаты (Phase 2 Exit)

| Критерий | Статус |
|---|---|
| TAKE/UPDATE/CLEAR через WS | ✅ |
| Output switch в Settings без redeploy | ✅ |
| Editor preview = engine (`@runtime`) | ✅ |
| Backend restart preserves on-air | ✅ NFR-1 |
| `run-engines.sh --dry-run` reads API | ✅ |

---

## 8. Ограничения / отложено

- Auth/RBAC — Phase 6
- Slot-aware rundown v2 — Phase 8
- DeckLink live validation — Phase 3/6.4

---

## 9. Артефакты

| Путь | Роль |
|---|---|
| `backend/src/` | API, WS, DB |
| `frontend/src/` | Editor, control, settings |
| `engine/run-engines.sh` | Multi-channel supervisor |
| `dev-start.sh` | Dev stack bootstrap |
| `docs/RUNBOOK.md` | Operations |
