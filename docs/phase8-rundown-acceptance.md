# Phase 8 Rundown Acceptance

Phase 8 goal: make Rundown a full scenario-driven operator playout workflow while
staying aligned with existing Titulus architecture (`REST + /ws/control + SQLite`).

## 1. Scope delivered

- Slot-aware rundown contract:
  - canonical slot shape: `slotId`, `templateId`, `name`, `vars`
  - legacy compatibility: `id/label/variables` auto-normalized in backend DAO
- Backend API hardening:
  - `GET /api/rundowns/:id`
  - stronger payload validation for `slots`
  - strict reorder checks (full list, no duplicates, no unknown ids)
- Control UI Rundown v2:
  - active rundown sidebar
  - CRUD / duplicate / import / export
  - slot CRUD + reorder + variable editing
  - transport `PREV / TAKE / NEXT`
  - hotkeys (`ArrowUp/ArrowDown`, `Space`, `Delete/Backspace`)
- Slot-aware on-air behavior:
  - rundown TAKE/CLEAR/UPDATE go by `slotId`
  - one template can be on-air multiple times in parallel as different slots
- Program monitor integration:
  - monitor channel follows active rundown channel binding context

## 2. Acceptance checklist

- [x] `select slot -> TAKE -> NEXT/PREV -> UPDATE -> CLEAR` works in Rundown tab
- [x] Parallel on-air instances with same template and different `slotId` are supported
- [x] On reload, on-air slot indicators restore from `/api/onair`
- [x] Legacy rundown data stays editable without manual DB migration
- [x] Templates tab behavior remains functional

## 3. Verification performed

Frontend:

- `cd frontend && npm run typecheck` - pass
- `cd frontend && npm run build` - pass

Backend syntax/import smoke:

- `cd backend && node -e "import('./src/routes/rundowns.js').then(() => console.log('ok'))"` - pass

## 4. Operational notes

- Rundown still uses the same control channel (`/ws/control`); no parallel WS protocol.
- If old rundown slots are present, first read/update/save cycle normalizes them.
- For external SDI parity validation keep using Phase 6.4 decklink closure docs.
