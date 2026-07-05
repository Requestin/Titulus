# Фаза 4 — Backend hardening

## Мета

| Поле | Значение |
|---|---|
| **Статус** | DONE |
| **PR** | #28–#31 |
| **Merge** | 2026-06-29 |

---

## 1. Цель / зачем

Надёжность **control plane** под реальной нагрузкой оператора: persistence on-air, robust media pipeline, structured validation, security baseline (NFR-3).

---

## 2. Исходное состояние

- Phase 2: базовый on-air, uploads, WS без hardening
- Нет `order_index`, слабая WS validation
- Template errors — неструктурированные

---

## 3. Scope

| # | Deliverable |
|---|---|
| 4.1 | On-air persistence hardening (`order_index`) |
| 4.2 | Media robustness (retry, timeout, MIME) |
| 4.3 | Structured template validation API |
| 4.4 | Cleanup + security baseline |

---

## 4. Реализация

### 4.1 On-air (PR #28)

- `on_air.order_index` — детерминированный z-order replay
- `onAirDao.set()` — `bringToFront` semantics
- Malformed JSON rows skip без crash backend startup
- WS errors не валят process — `{type:'error', error:...}`

### 4.2 Media (PR #29)

- MIME + extension allow-list на uploads
- Structured errors: `error.code/message/details`
- ffmpeg retry, timeout guard, bounded stderr tail
- CORS для `/api/uploads`, `/uploads` static

### 4.3 Validation (PR #30)

- `templateValidation.js` — enriched AJV diagnostics
- `POST /api/templates/validate` → 200 valid / 422 structured invalid
- Create/update используют тот же payload shape

### 4.4 Security (PR #31)

- WS message size cap 256KB → close 1009
- Strict payload validation: take/update/clear
- Global headers: `X-Content-Type-Options`, `X-Frame-Options`, etc.
- Dead code cleanup

---

## 5. PR / Git

| # | Title | Ключевые файлы |
|---|---|---|
| 28 | [Phase 4.1] on-air persistence hardening | `db.js`, `onair.js` |
| 29 | [Phase 4.2] media robustness for uploads pipeline | `media.js`, `uploads.js` |
| 30 | [Phase 4.3] structured template validation API | `templateValidation.js` |
| 31 | [Phase 4.4] cleanup + backend security baseline | `ws.js`, `index.js` |

---

## 6. Проверка

```bash
# On-air order after restart
# take T1 → take T2 → kill backend → start → replay order preserved

# Invalid template
curl -X POST /api/templates/validate -d '{"invalid":true}' → 422 structured

# Oversized WS → close 1009
```

---

## 7. Результаты

| Критерий | Статус |
|---|---|
| NFR-1 on-air усилен | ✅ |
| Structured 422 validation | ✅ |
| WS security baseline | ✅ |
| Media retry/timeout | ✅ |

---

## 8. Ограничения / отложено

- Auth/RBAC — Phase 6.2 (после Phase 4)
- Rate limiting — future

---

## 9. Артефакты

| Путь | Роль |
|---|---|
| `backend/src/db.js` | `order_index` migration |
| `backend/src/onair.js` | OnAirManager |
| `backend/src/routes/ws.js` | WS hardening |
| `backend/src/templateValidation.js` | AJV diagnostics |
