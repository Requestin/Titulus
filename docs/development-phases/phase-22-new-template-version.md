# Phase 22 — New template version

**Статус:** DONE — новая схема канон; operator exam PASS; Unreal/WebM excluded  
**Дата открытия:** 2026-08-23  
**Дата закрытия:** 2026-08-24  
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

| Шаг | Содержание | Статус |
|---|---|---|
| P22.0 | этот документ + development-plan | DONE (PR #144) |
| P22.1 | convert + staged allowlist + переписанные museum-тесты | DONE (PR #145) |
| P22.2 | text-transform, shadow, clock bind, crawl file/copy, Data panel, timeline leftovers | DONE (PR #146) |
| P22.3 | WebP in/out window | DONE (PR #147) |
| P22.4 | LayerID stack + default ON после visual | DONE (PR #148) |
| P22.5 | Control DE, MAM picker, folders, test-mode, thumbs, locks, RBAC UI | DONE (PR #149) |
| P22.6 | null/DeckLink 1ch/3ch на сконвертированных fixtures | DONE — telemetry PASS; visual PASS (operator close) |
| P22.7 | goldens + SDI exam на шаблонах оператора, затем close | DONE — `newtest1`/`newtest2` + 15m 3ch; фаза закрыта |

P22.7 закрыт оператором 2026-08-24.

## 5. Видео

Как ADR P21.8 и выбор оператора 2026-08-23: air = animated WebP.
Разрешено окно показа. Запрещены `videoProgress`, seek/scrub, WebM.

## 6. Rollback

`git revert <merge-commit>`, rebuild `bg-runtime.js`.
Allowlist — одним revert. DB — copied `app.db` до migrate-утилиты.

## 7. Allowlist

Все 16 known capability сейчас в `supported[]` (P22.1–P22.4):

- `properties.position-z`
- `rectangle.four-corner-gradient`
- `text.shadow`
- `text.transform`
- `crawl.layer`
- `timeline.object-track-groups`
- `timeline.action-cues-items`
- `timeline.action-from-end`
- `timeline.continue-wait`
- `timeline.protected-update-flow`
- `data.expanded-variable-types`
- `data.sources-formats`
- `data.select-map-policies`
- `data.time-expressions`
- `data.media-token-resolution`
- `control.layer-id-on-air`

Неизвестная или невыведенная capability по-прежнему 422.

## 8. P22.6 gate

Отчёт: `docs/performance investigation/reports/p22-06-converted-gate.md`.

T0 зелёный. Copied-DB migrate на канонических fixtures — 0 rewrite,
геометрия та же. Null и DeckLink 1ch/3ch ≤5 мин: `(2,0)=0`,
late/drop/flush/unlock = 0. Сценарии Crawl / Continue / prepare `block` /
LayerID replace / WebP window — PASS.

Visual PASS — оператор закрыл фазу 2026-08-24. Residual
`single`/`overwrite` записаны и не объявлены шумом.

## 9. P22.7 — шаблоны оператора

Набор оператора зафиксирован:

- `tests/fixtures/p22/operator/newtest1.json` — сцена без видео
- `tests/fixtures/p22/operator/newtest2.json` — сцена с видео
- медиа: `tests/fixtures/p22/operator/media/` + `seed-media.sh`
- goldens: `tests/fixtures/p22/expected/newtest{1,2}.{normalized,capabilities}.json`

Все новые тесты производительности — только на этих шаблонах, не на
музейном `test1` / `p20-test1-visual`.

Отчёт: `docs/performance investigation/reports/p22-07-operator-templates.md`.
15m 3ch DeckLink на `newtest2`: `(2,0)=0`, late/drop/flush = 0, pose
49.71 / 49.89 / 49.88. Residual записаны. Оператор закрыл P22.7 и фазу.

## 10. Закрытие

Phase 22 закрыта 2026-08-24. Новая схема — единственный язык продукта.
Старые шаблоны конвертируются в vNext. Эфир открыт staged `supported[]`.
Видео — WebP без скраба и без WebM. Unreal/VS в `main` нет.

Финальный exam — операторские `newtest1` / `newtest2`, не музейный `test1`.
Следующая работа — вне этого документа. Engine-first rule и deferred
on-wire gate остаются в силе.

Evidence:

- [p22-06-converted-gate.md](../performance%20investigation/reports/p22-06-converted-gate.md)
- [p22-07-operator-templates.md](../performance%20investigation/reports/p22-07-operator-templates.md)

Rollback по-прежнему `git revert <merge-commit>` одного milestone, затем
rebuild `bg-runtime.js`.

## 11. Индекс PR

| PR | Задача |
|---|---|
| #144 | P22.0 phase doc + development-plan |
| #145 | P22.1 convert + staged allowlist |
| #146 | P22.2 leftover editor capabilities |
| #147 | P22.3 WebP in/out window |
| #148 | P22.4 LayerID stack |
| #149 | P22.5 Control DE / MAM / folders / RBAC |
| #152–#155 | crawl continuous travel / duration |
| #156 | P22.7 operator fixtures `newtest1`/`newtest2` |

