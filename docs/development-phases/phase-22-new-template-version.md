# Phase 22 — New template version

**Статус:** IN PROGRESS
**Дата открытия:** 2026-08-23
**База:** `origin/main` после Phase 21 close (`55e50e3`)
**Предшественник:** Phase 21 New Designer Merge
**Главный приоритет:** сделать новую схему единственным языком продукта,
не ухудшив engine cadence и не взяв Unreal / Sergey engine / WebM

## 1. Цель

Phase 21 перенесла designer UX на current `main`, но эфир остался за
вахтёром: `supported = []`. Phase 22 снимает музей «только старые fixtures
в эфире»:

1. старые шаблоны конвертируются в vNext (геометрия и движение те же);
2. `supported[]` наполняется **по одному id**, когда поведение реально
   работает;
3. editor leftover Сергея (без Unreal) доводится до эфира;
4. видео — только WebP окно показа (in/out, visibility), без скраба и WebM;
5. LayerID становится настоящей этажеркой после visual gate;
6. операторские экраны (DE, MAM, папки, RBAC) дорисовываются;
7. финальный exam — **новые шаблоны, которые нарисует оператор**, не
   музейный `test1`.

## 2. Неприкосновенное

- Current `origin/main` engine/runtime. Не merge `sergey-v1` engine.
- CPU-only CEF, `one_tick`, Class-A, WebP ingest, layered OFF.
- `sampleAt` fast path для шаблона без живых directors **не удалять**.
- `TITULUS_FILE_ROOTS` default empty. Unreal/VS/NDI/chroma не переносить.
- Live cell ≤ 5 мин на i7. Visual PASS только после глаз оператора.
- Residual `single`/`overwrite` не объявлять шумом.

## 3. Конвертация

`migrateTemplate` клонирует шаблон, поднимает legacy `actions` → `cues`,
проставляет defaults без смены x/y/anchor/`rootStack`, записывает
`capabilities = required`. GET отдаёт канон; PUT пишет канон; утилита
гоняет **копию** `app.db`.

Persist остаётся равен air: capability вне `supported[]` → 422.

## 4. План PR

| Шаг | Содержание |
|---|---|
| P22.0 | этот документ + development-plan |
| P22.1 | convert + staged allowlist + переписанные museum-тесты |
| P22.2 | text-transform, shadow, clock bind, crawl file/copy, Data panel, timeline leftovers |
| P22.3 | WebP in/out window |
| P22.4 | LayerID stack + default ON после visual |
| P22.5 | Control DE, MAM picker, folders, test-mode, thumbs, locks, RBAC UI |
| P22.6 | null/DeckLink 1ch/3ch на сконвертированных fixtures |
| P22.7 | goldens + SDI exam на шаблонах оператора, затем close |

P22.7 не закрывает фазу без набора оператора.

## 5. Видео

Как ADR P21.8 и выбор оператора 2026-08-23: air = animated WebP.
Разрешено окно показа. Запрещены `videoProgress`, seek/scrub, WebM.

## 6. Rollback

`git revert <merge-commit>`, rebuild `bg-runtime.js`.
Allowlist — одним revert. DB — copied `app.db` до migrate-утилиты.
