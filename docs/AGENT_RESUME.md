# AGENT_RESUME — точка старта для нового агента

**Прочитай ЭТОТ файл первым** после `git clone`/`git pull`, чтобы понять, где проект и что делать дальше.

Сводка: где остановились, как запустить проект, как проверить свою работу, какой workflow соблюдать. Подробности — в связанных документах.

---

## 1. Где проект сейчас (snapshot)

| Phase | Статус | Канонический документ |
|---|---|---|
| 0 — engine skeleton + bench | ✅ DONE | `docs/PHASE0_BENCH.md` |
| 1 — shared runtime + channel page | ✅ DONE | `99-session-history.mdc` |
| 2 — control plane (backend + frontend + output) | ✅ DONE | `99-session-history.mdc` |
| 3 — DeckLink SDI consumer | ✅ code-complete, ⏳ HW deferred | `docs/phase3-decklink-validation-deferred.md` |
| 4 — backend hardening | ✅ DONE | `99-session-history.mdc` |
| 5 — stream output + AI schema + docs | ✅ DONE | `docs/ARCHITECTURE.md`, `docs/RUNBOOK.md` |
| 6.1–6.3 — license + auth + billing/audit | ✅ DONE | `99-session-history.mdc` |
| 6.4 — DeckLink HW validation | ⏳ external-blocked | `docs/phase6-decklink-validation-closure.md` |
| 7 — docs/rules consolidation | ✅ DONE | `docs/PHASE_REPORT_PHASE1_TO_PHASE7.md` |
| 8 — rundown v2 (slot-aware) | ✅ DONE | `docs/phase8-rundown-acceptance.md` |
| **9 — 2.5D + stack-scoped masks** | ✅ **DONE (последняя)** | **`docs/phase9-25d-masks.md`** |

**Последний merged PR:** #47 (`[Phase 9.7] bench 2.5D scenes + phase9-25d-masks.md`).  
**Текущая ветка:** `main`, чистый.  
**Дата snapshot:** июль 2026.

---

## 2. Следующие шаги (приоритеты)

1. **Phase 6.4 — SDI hardware validation (external-blocked).**
   Нужен хост с DeckLink + genlock. Runbook: `docs/phase6-decklink-validation-closure.md`, evidence: `engine/collect-decklink-evidence.sh`.
   Если железа нет — этот пункт **пропускается**, переход к п.2.

2. **Phase 6+ stretch (без HW):**
   - Multi-tenant SaaS auth/billing поверх Phase 6.x foundation.
   - License activation с внешним provider.
   - NDI output consumer.
   - GPU path — **только** через GPU Gate doc (`docs/DEVELOPMENT_PROMPT.md` §0.2.1).

3. **Развитие control plane поверх rundown v2** (`docs/phase8-rundown-acceptance.md`):
   новые операторские сценарии, hotkeys, templates marketplace, AI template generation.

4. **2.5D / masks Phase 10 (не MVP):**
   из known limits `docs/phase9-25d-masks.md` §9 — outer/inner layout split, temporal coherence evaluator, cost indicator в UI, `compositorLayers` в RenderStats.

---

## 3. First 5 минут на новой машине

```bash
git clone https://github.com/Requestin/Titulus.git
cd Titulus

# Проверь, что main чистый и актуальный
git status
git log --oneline -5
# Ожидается: 4a3237d docs(phase9): consolidate... ; b5550da [Phase 9.7]...

# Установи deps (dev-start.sh сделает это сам, но проверь)
cd runtime && npm install && cd ..
cd backend && npm install && cd ..
cd frontend && npm install && cd ..

# Собери runtime bundle (обязательно для channel.html и Program Monitor)
cd runtime && npm run build && cd ..
# Ожидается: ../backend/public/bg-runtime.js 24-28kb

# (Опционально) Собери bg_engine
./engine/third_party/fetch-cef.sh   # one-time
cd engine && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j"$(nproc)" && cd ..
```

Запуск всего стека:

```bash
./dev-start.sh
# frontend: http://127.0.0.1:3011
# backend:  http://127.0.0.1:3002
# логин:    admin / admin123
# data:     /tmp/titulus-dev  (tmpfs; прод. → /var/lib/titulus)
# logs:     /root/Titulus/logs/
```

Остановка:

```bash
./dev-stop.sh
```

LAN-доступ с другого ПК (по умолчанию): `http://<этот-host-LAN-IP>:3011`.  
localhost-only: `TITULUS_HOST=127.0.0.1 ./dev-start.sh`.

---

## 4. Smoke checks

```bash
# Backend живой
curl -s http://127.0.0.1:3002/api/health
# {"ok":true,"service":"titulus-backend"}

# Получить токен
TOKEN=$(curl -s -X POST http://127.0.0.1:3002/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | jq -r .token)

# Защищённый endpoint
curl -s http://127.0.0.1:3002/api/channels -H "Authorization: Bearer $TOKEN" | jq

# Template validation
curl -s -X POST http://127.0.0.1:3002/api/templates/validate \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"id":"t","name":"T","canvas":{"width":1920,"height":1080,"background":"transparent"},"variables":[],"groups":[],"layers":[],"rootStack":[],"groupStacks":{},"timeline":{"fps":50,"durationFrames":1,"playbackMode":"bounded","directors":[{"id":"d","name":"D","durationFrames":1,"offsetFrames":0,"autostart":true,"loop":false,"swing":false}],"trackDirectors":{},"keyframes":[],"actions":[]}}'
```

Engine smoke (если собран):

```bash
ENGINE=/root/Titulus/engine/build/Release/bg_engine
"$ENGINE" --consumer=null \
  --url="file://$PWD/bench/bench-mask-stack.html" \
  --fps=50 --duration=3 --width=1920 --height=1080 \
  --cache-dir=/tmp/smoke
# Ожидается: SUMMARY frames=N fps=~50 drops=0.000%
```

Runtime typecheck:

```bash
cd runtime && npx tsc --noEmit && cd ..
cd frontend && npx tsc --noEmit && cd ..
```

Runtime rebuild (после правок в `runtime/src/*`):

```bash
cd runtime && npm run build && cd ..
```

---

## 5. Workflow (ОБЯЗАТЕЛЬНО)

Источник правды: `.cursor/rules/02-git-workflow.mdc`. Краткая выжимка:

```
1. PLAN → описать задачу, exit criteria, имя ветки
2. BRANCH → git checkout main && git pull && git checkout -b feature/phase-N-<kebab>
3. IMPLEMENT → атомарные коммиты (1 логика = 1 commit)
4. PUSH → git push -u origin HEAD
5. PR → gh pr create (Summary / Task / Phase / Changes / Test plan / Rollback)
6. REVIEW → проверить diff
7. MERGE → gh pr merge --merge   ← merge commit, НЕ squash
8. REPORT → ссылка PR + hash merge commit
```

Имена веток: `feature/phase-N-<short>`, `fix/<short>`, `docs/<short>`, `bench/<short>`, `chore/<short>`.

PR title для фаз: `[Phase N.M] <краткое>`.

Коммиты: Conventional Commits (`feat`, `fix`, `docs`, `refactor`, `chore`, `bench`, `engine`), тело коммита детальное на русском/английском.

**На конец сессии:** ВСЕГДА commit + push, не оставлять dirty tree.

---

## 6. Канонические документы (читать при сомнениях)

| Что | Где |
|---|---|
| Spec (высший приоритет) | `docs/DEVELOPMENT_PROMPT.md` |
| Архитектура | `docs/ARCHITECTURE.md` |
| Runbook (запуск, troubleshooting) | `docs/RUNBOOK.md` |
| История диалога/решений | `.cursor/rules/99-session-history.mdc` |
| План разработки | `.cursor/rules/10-development-plan.mdc` |
| Скиллы под задачу | `.cursor/rules/11-skills-map.mdc` |
| Phase 9 (2.5D + маски) | `docs/phase9-25d-masks.md` |
| Phase 8 (rundown v2) | `docs/phase8-rundown-acceptance.md` |
| Phase 6.4 handoff | `docs/phase6-decklink-validation-closure.md` |
| Исторический отчёт | `docs/PHASE_REPORT_PHASE1_TO_PHASE7.md` |
| Sandobx policy | `.cursor/rules/05-sandbox-policy.mdc` |
| Engine porting (CasparCG) | `engine/CASPARRCG_PORTING.md` |

При конфликте источников: `DEVELOPMENT_PROMPT.md` + `.cursor/rules/*.mdc` > всё остальное.

---

## 7. Технические грабли (короткий список, подробно в `99-session-history.mdc`)

1. `/root/Titulus/data` нестабилен для SQLite → всегда `TITULUS_DATA=/tmp/...` для тестов.
2. Bash subshell `( )` сбрасывает CWD → используй `cd /path && cmd` в одной строке.
3. CJS-dep импорты в ESM backend → `import WebSocket from 'ws'` (default), НЕ `{ WebSocket }`.
4. CEF `LOG(severity)` конфликтует с нашим макросом → `BG_LOG()`.
5. CEF subprocess guard: `CefExecuteProcess` ДО своего arg-parse.
6. Write-tool сбрасывает executable bit `.sh` → `chmod +x`.
7. `pkill -f "PORT=N"` НЕ убивает backend (env var) → kill по PID: `ss -ltnp | grep ':N'`.
8. jsdom: НЕ перезаписывай `globalThis.performance`.
9. Runtime dirty-check: после `syncTemplate` повторный `seek` = `writes: 0` (это ожидаемо, не баг).

---

## 8. Проверенные подходы

- **Backend test:** `cd backend && PORT=3097 TITULUS_DATA=/tmp/t node src/index.js > /tmp/be.log 2>&1 &` + curl/ws-client; kill по PID порта.
- **Runtime pure-logic test:** `cd runtime && npx tsx test.mjs` (jsdom + `pretendToBeVisual: true` + rAF shim).
- **Engine на channel.html:** backend поднял static, `bg_engine --url=http://localhost:3939/channel.html?engine=1`.
- **WS flow smoke:** throwaway `test_ws.mjs` в `backend/` (НЕ коммитить) — образец в `99-session-history.mdc`.
- **Per-frame stats (runtime):** `channel.html?hud=1` показывает `styleWrites` / `skippedWrites` (Phase 9.1).

---

## 9. Что НЕ делать

- Включать GPU без GPU Gate doc.
- PIXI.js / GSAP / WebGL-as-primary.
- Запускать CasparCG как runtime dependency.
- Копировать sandbox `broadcast-graphics/engine/` (render authority = CasparCG + наш clean-room).
- Один Chromium на все каналы (singleton contention).
- `--headless` для CEF (ломает Alloy OSR).
- SCHED_RR/RT для engine (RT throttling ухудшает).
- Squash PR (merge commit для revert-точек).
- Коммитить `data/app.db`, `bg-runtime.js` (generated), `engine/build/`, `engine/third_party/cef/`, `node_modules/`.
- Оставлять dirty tree на конец сессии.

---

## 10. Контекст разработки (для понимания «почему»)

- **Заказчик:** Karen Darchiniants (`k.darchiniants@gyhyry.com`), repo `github.com/Requestin/Titulus`.
- **Продукт:** облачная титровальная система для эфирного ТВ, 2D + 2.5D графика уровня новостных выпусков.
- **Дифференциатор:** собственный `bg_engine` (clean-room из CasparCG), современный cloud control plane, JSON-schema AI-ready templates.
- **Доступ к dev-серверу:** заказчик работал через Remote SSH (Windows Cursor → Ubuntu dev server). Возможно продолжение на домашнем Linux-хосте: `git clone` + `./dev-start.sh` поднимает полный стек без доработок.
- **Коммиты и PR** на русском + английском, тело детальное.
- **Честность в отчётах:** НЕ фабриковать цифры. CasparCG baseline = pending; VM-jitter документирован; HW validation честно deferred.

---

## 11. Если задача — новая фича

1. Прочитай канон по теме в `docs/DEVELOPMENT_PROMPT.md`.
2. Проверь, нет ли готового в CasparCG (`CasparCG/server`) для render-задач.
3. Для control plane — используй slot-aware rundown v2 (`docs/phase8-rundown-acceptance.md`) как base.
4. Runtime-логика — ТОЛЬКО в `@titulus/runtime`, НЕ в frontend (`03-conventions.mdc`).
5. Сделай bench/verification-loop, если трогаешь engine/perf (`verification-loop` skill).
6. После каждого изменения engine — re-bench + обновить `docs/PHASE0_BENCH.md` при regress.
7. Каждый PR = merge commit в `main`.

---

**TL;DR для нового агента:** `git clone` → `./dev-start.sh` → `http://127.0.0.1:3011` (`admin`/`admin123`) → читай `.cursor/rules/99-session-history.mdc` + `docs/phase9-25d-masks.md` для контекста → следующий milestone — Phase 6.4 (нужен HW) либо control-plane / Phase 6+ stretch.
