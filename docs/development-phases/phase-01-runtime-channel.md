# Фаза 1 — Shared runtime + channel page

## Мета

| Поле | Значение |
|---|---|
| **Статус** | DONE |
| **PR** | #8–#13 |
| **Merge** | июнь 2025 |

---

## 1. Цель / зачем

Единая **render-логика JSON→DOM** для engine, editor, thumbnails и OBS browser source. End-to-end: `bg_engine` загружает `channel.html` и рендерит шаблоны через WebSocket.

Принцип: один `@titulus/runtime` — WYSIWYG без дублирования render-кода.

---

## 2. Исходное состояние

- Phase 0: `bg_engine` + bench HTML, null consumer proven
- Нет shared TS runtime, нет channel page, нет WS client

---

## 3. Scope

| # | Deliverable |
|---|---|
| 1.1 | `schema.ts` + JSON Schema (6 layer types) |
| 1.2 | timeline, easing, transform, stackOrder, clock, fonts |
| 1.3 | `TemplateRenderer` (domRenderer) |
| 1.4 | `ChannelClient` (WS renderer client) |
| 1.5 | esbuild IIFE `bg-runtime.js` |
| 1.6 | `channel.html` engine/browser page |

---

## 4. Реализация

### @titulus/runtime

| Модуль | Роль |
|---|---|
| `schema.ts` | Domain model: layers, groups, timeline, variables |
| `timeline.ts` | Directors, keyframes, actions, fixed-step playback |
| `easing.ts` | linear, power2, bounce, elastic, cubic-bezier |
| `transform.ts` | Anchor-aware CSS transforms |
| `stackOrder.ts` | DFS flatten z-order |
| `domRenderer.ts` | `TemplateRenderer` — mount, seek, applyState |
| `channelClient.ts` | WS take/update/clear + reconnect |
| `clock.ts`, `fonts.ts` | strftime-like clock, Font Loading API |

### Build

- `runtime/build.mjs` → IIFE `backend/public/bg-runtime.js`
- `window.BG`, ~17.5 KB, zero runtime deps

### channel.html

- Query params: `channel`, `engine`, `preview`, `ws`, `fps`
- `BG.ChannelClient` + perpetual **rAF heartbeat** (критично для CEF OSR)
- Engine mode: fixed-step tick bridge (`setInterval` → позже unified rAF в Phase 11)
- 6 layer types, 2D masks через clip-path

---

## 5. PR / Git

| # | Title | Ключевые файлы |
|---|---|---|
| 8 | [Phase 1] template domain model — schema.ts + JSON Schema | `runtime/src/schema.ts`, `shared/` |
| 9 | [Phase 1] timeline/easing/transform/stackOrder/clock/fonts | `runtime/src/*.ts` |
| 10 | [Phase 1] TemplateRenderer (DOM renderer) | `domRenderer.ts` |
| 11 | [Phase 1] ChannelClient (WS client) | `channelClient.ts` |
| 12 | [Phase 1] esbuild IIFE bundle → bg-runtime.js | `build.mjs` |
| 13 | [Phase 1] channel.html engine/browser page | `backend/public/channel.html` |

---

## 6. Проверка

```bash
cd runtime && npm run build && npx tsc --noEmit

# Engine + channel.html
python3 -m http.server 3939 -d backend/public &
bg_engine --url=http://127.0.0.1:3939/channel.html?engine=1&channel=ch1 --duration=10
# → ~233 frames/10s
```

---

## 7. Результаты

| Критерий | Статус |
|---|---|
| Engine рендерит channel.html end-to-end | ✅ |
| Один runtime для editor/engine | ✅ |
| Timeline fixed-step + rAF | ✅ |
| WS без backend в тесте | reconnect-storm ~46% drops (не renderer bug; bench ~48fps) |

---

## 8. Ограничения / отложено

- Backend WS + on-air — Phase 2
- 2.5D / stack masks — Phase 9
- Unified clock (rAF tick) — Phase 11.2

---

## 9. Артефакты

| Путь | Роль |
|---|---|
| `runtime/src/` | Shared render logic |
| `runtime/build.mjs` | IIFE bundle |
| `backend/public/channel.html` | Engine/browser page |
| `shared/template.schema.json` | JSON Schema |
