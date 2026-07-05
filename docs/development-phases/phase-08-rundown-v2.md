# Фаза 8 — Rundown v2 (slot-aware playout)

## Мета

| Поле | Значение |
|---|---|
| **Статус** | DONE |
| **PR** | #40 |
| **Merge** | 2026-06-29 |

---

## 1. Цель / зачем

**Пошаговый эфирный сценарий** (rundown): слоты с собственным `slotId`, transport PREV/TAKE/NEXT, возможность держать **один шаблон в эфире несколько раз** как разные slots.

Operator workflow поверх существующего WS/REST без смены render plane.

---

## 2. Исходное состояние

- Phase 2: rundowns CRUD + reorder, Templates tab TAKE
- Legacy slots: `id`, `label`, `variables` — без slot-aware on-air
- Нет dedicated Rundown operator UI

---

## 3. Scope

- Slot contract: `{ slotId, templateId, name, vars }`
- Backend API + мягкая миграция legacy
- `RundownTab` в Control panel
- Program Monitor → channel binding активного rundown
- Hotkeys, inline vars editing

---

## 4. Реализация

### Data contract

- `slotId` — эфирная identity (передаётся как `templateId` в WS take)
- Один `templateId` может иметь несколько slots с разными `vars`
- Legacy `id/label/variables` → нормализация в DAO на read/write

### Backend (PR #40)

- `GET /api/rundowns/:id` — полный rundown
- Strict validation slots, reorder (full-list, no duplicates)
- Defaults на create

### Frontend

- `RundownTab.tsx`: active rundown sidebar, CRUD/duplicate/import/export
- Slot CRUD/reorder, PREV/TAKE/NEXT transport
- Hotkeys: стрелки, Space, Delete
- Debounced live slot vars update (UPDATE по slotId)
- On-air индикация slot-aware

### WS (без изменения протокола)

```json
{ "type": "take", "templateId": "<slotId>", "channelId": "...", "template": {...}, "variables": {...} }
```

---

## 5. PR / Git

| # | Title | Ключевые файлы |
|---|---|---|
| 40 | [Phase 8] Rundown mechanism v2 — slot-aware operator playout | `rundowns.js`, `RundownTab.tsx`, `onair.js` |

---

## 6. Проверка

| Сценарий | Статус |
|---|---|
| select → TAKE → NEXT/PREV → UPDATE → CLEAR | ✅ |
| Один template в эфире как разные slotId | ✅ |
| Replay on-air после reload | ✅ |
| Legacy rundown нормализуется | ✅ |
| `frontend` typecheck + build | ✅ |

---

## 7. Результаты

- Rundown — полноценный operator mode
- Templates tab не деградировал
- Program Monitor синхронизирован с rundown channel binding

---

## 8. Ограничения / отложено

- Multi-rundown concurrent on-air UI polish
- Rundown versioning / audit per slot

---

## 9. Артефакты

| Путь | Роль |
|---|---|
| `frontend/src/control/RundownTab.tsx` | Operator UI |
| `backend/src/routes/rundowns.js` | API |
| `backend/src/db.js` | Slot normalization |
