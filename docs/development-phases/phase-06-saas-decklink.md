# Фаза 6 — SaaS foundation + DeckLink closure

## Мета

| Поле | Значение |
|---|---|
| **Статус** | 6.1–6.3 DONE; 6.4 IN PROGRESS (handoff ready) |
| **PR** | #35, #36, #37 |
| **Merge** | 2026-06-29 |

---

## 1. Цель / зачем

Заложить **enterprise-основу** (лицензия, auth/RBAC, billing/audit) для cloud/on-prem SaaS и **формализовать SDI-приёмку** на HW-хосте — чтобы Phase 3 code-complete перешёл в production sign-off с evidence bundle.

---

## 2. Исходное состояние

- Phase 2–5: полный operator loop, stream output, docs
- DeckLink consumer code-complete, но dev-сервер без платы
- Нет auth, license, audit trail

---

## 3. Scope

| Подфаза | Deliverable |
|---|---|
| **6.1** | License activation foundation (local) |
| **6.2** | Auth + RBAC baseline |
| **6.3** | Billing entitlements + audit events |
| **6.4** | DeckLink validation closure pack + evidence tooling |

---

## 4. Реализация

### 6.1 License (PR #35)

- SQLite `license_state`, DAO в `backend/src/db.js`
- REST: `/api/license`, `/activate`, `/deactivate`, `/check`
- Settings UI: status, masked key, activate/deactivate
- **Намеренно local** — внешний provider отложен

### 6.2 Auth + RBAC (PR #36)

- Таблицы `users`, `sessions`, `tenants`
- Bootstrap admin (`admin` / `admin123` в dev)
- Роли `admin` | `operator`
- Guarded REST: channels, license, settings, mutating routes
- `/ws/control` требует auth token (query/header)
- Frontend: login page, session storage, guarded routes

### 6.3 Billing + audit (PR #36)

- `audit_events` с sanitization sensitive payload
- `/api/audit/events`, `/api/billing/entitlements`
- Webhook skeleton `/api/billing/hook` (secret-protected)
- Entitlements привязаны к license plan (`none/starter/pro/enterprise`)
- Settings: recent audit block (admin)

### 6.4 DeckLink closure (PR #37 + live evidence Phase 10–11)

**Handoff pack:**

- Validation matrix: signal lock, visual parity, 8h soak, ops
- `engine/collect-decklink-evidence.sh` — стандартизированный bundle
- Диагностика домашнего хоста (Quad 2 + LES DG-14B genlock)

**HW-стенд (подтверждено):**

| Параметр | Значение |
|---|---|
| CPU | AMD Ryzen 5 3600, 6C/12T |
| Карта | DeckLink Quad 2, profile `1dfd` |
| Genlock | LES DG-14B → Reference In |
| SDI | 3 одновременных выхода, `ref=locked` |

**Connector mapping (эмпирически):**

- SDK `device-index=1` → физический SDI #3
- Reference In — mini-DIN у bracket

**Evidence bundle:**

```bash
OUT_ROOT=/var/log/titulus ./engine/collect-decklink-evidence.sh
```

Содержимое: `env.txt`, `channels.json`, `engine.log`, `soak-summary.txt`, …

---

## 5. PR / Git

| # | Title | Ключевые файлы |
|---|---|---|
| 35 | [Phase 6.1] license activation foundation | `backend/src/routes/license.js`, Settings UI |
| 36 | [Phase 6.2/6.3] auth boundaries + billing audit baseline | auth routes, `audit_events`, WS guard |
| 37 | [Phase 6.4] decklink hardware handoff evidence tooling | `collect-decklink-evidence.sh`, closure checklist |

---

## 6. Проверка

```bash
# Auth smoke
curl -X POST http://127.0.0.1:3002/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}'

# License check
curl http://127.0.0.1:3002/api/license/check -H "Authorization: Bearer <token>"

# Evidence (на HW-хосте)
OUT_ROOT=/var/log/titulus ./engine/collect-decklink-evidence.sh
```

---

## 7. Результаты

| Подфаза | Статус |
|---|---|
| 6.1 License API + UI | ✅ |
| 6.2 Auth/RBAC + WS guard | ✅ |
| 6.3 Audit + entitlements | ✅ |
| 6.4 Formal 8h soak | ⏳ |
| Genlock locked на стенде | ✅ |
| 3ch concurrent SDI (Phase 10/11) | ✅ |
| Fill+Key A/B CasparCG | ⏳ |

---

## 8. Ограничения / отложено

- External license provider / multi-tenant billing sync
- Формальный 8h soak и CasparCG A/B — не закрыты checklist'ом
- NDI, stretch SaaS — Phase 6+

---

## 9. Артефакты

| Путь | Роль |
|---|---|
| `backend/src/routes/license.js` | License API |
| `backend/src/routes/auth.js` | Login/session |
| `backend/src/db.js` | users, sessions, audit, license DAOs |
| `engine/collect-decklink-evidence.sh` | Evidence collector |
| `docs/RUNBOOK.md` | HW handoff flow |
