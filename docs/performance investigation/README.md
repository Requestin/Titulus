# Performance Investigation — индекс документов

**Программа:** PI07 — выход на ≥50 unique fps при 3×1080i50 сложных templates на Ryzen 5 3600 (и пропорциональный scale).  
**Снимок:** 2026-07-13  
**Constraints:** CPU-only CEF OSR · HTML5/DOM · DeckLink + genlock · CasparCG = reimplement-by-reference · git-workflow merge commits  

Эта папка — **аналитический и исполнительный пакет** после Phase 15–18. Phase 18 доказал: true 50p-as-50i на cheap content уже есть; на `test1` потолок ~25 unique fps — **content/raster-bound**, не pump. Дальше — снижать стоимость кадра и (при необходимости) менять архитектуру композитинга.

## Тестовые шаблоны (canonical)

Все perf-замеры серии используют шаблоны из `tests/templates/`:

| Шаблон | Путь | Класс | Роль |
|---|---|---|---|
| `test` | [`tests/templates/test.json`](../../tests/templates/test.json) | простой (cheap) | sanity / regression canary; true 50p уже работает |
| `test1` | [`tests/templates/test1.json`](../../tests/templates/test1.json) | сложный (complex) | **acceptance target**: целевые показатели программы (3ch ≥50 unique fps) обязаны достигаться именно на нём |

Везде в docs 00–07, где упоминаются `test` / `test1` без пути, имеются в виду эти файлы. PASS на `test` или bench-сценах не заменяет PASS на `test1`.

## Как читать

1. Начните с [`00-overview-and-cost-model.md`](./00-overview-and-cost-model.md) — budgets и cost model.  
2. Держите под рукой master plan [`07-execution-roadmap-and-verification.md`](./07-execution-roadmap-and-verification.md) — порядок работ и numeric gates.  
3. Открывайте sister docs по текущему workstream (не все сразу).  
4. Не объявляйте «true 50p» без `in_fps≥50` **и** высокого `d_pairs` (см. doc 07 §1).

## Документы (00–07)

| # | Файл | Содержание | Когда обязателен |
|---|---|---|---|
| 00 | [`00-overview-and-cost-model.md`](./00-overview-and-cost-model.md) | Обзор проблемы, frame budgets, feature cost matrix, Style Guide foundation | Старт программы; GATE-00 |
| 01 | [`01-blink-raster-cost-reduction.md`](./01-blink-raster-cost-reduction.md) | Снижение Blink/Skia cost: beacon, CSS, masks, layers, runtime | После GATE-00; главный short-term lever |
| 02 | [`02-cpu-layer-compositor.md`](./02-cpu-layer-compositor.md) | Собственный CPU layered compositor (архитектурная ставка) | Только если после 01(+03/04/05) всё ещё ниже gate |
| 03 | [`03-zero-copy-memory-pipeline.md`](./03-zero-copy-memory-pipeline.md) | Fewer-copy / zero-copy путь кадров, memory bandwidth | Параллельно после GATE-01 |
| 04 | [`04-scheduling-os-and-genlock.md`](./04-scheduling-os-and-genlock.md) | Pinning, CCX/topology, isolcpus, SCHED_FIFO, genlock | Параллельно после GATE-01 |
| 05 | [`05-cef-pipeline-and-upgrade.md`](./05-cef-pipeline-and-upgrade.md) | CEF/OSR options, upgrade, pull-model ideas; dual-BF только с новой evidence | Conditional (decision D1 в doc 07) |
| 06 | [`06-microfreeze-elimination.md`](./06-microfreeze-elimination.md) | Микрофризы (~5–11s): инструментация и устранение | Параллельно после GATE-01 (качество эфира) |
| 07 | [`07-execution-roadmap-and-verification.md`](./07-execution-roadmap-and-verification.md) | **Master roadmap:** порядок WS, gates, bench, soak, DoD, risks, rollback, cadence | Всегда; governance |

## Упорядоченный workstream (кратко)

```
00 cost model → 01 raster cost
                 ↓
         (03 memory ∥ 04 scheduling ∥ 06 microfreeze)
                 ↓
         D1: headless test1 ≥45–50?
            ├─ no  → 05 CEF (если нужно)
            └─ yes → skip/light 05
                 ↓
         still below? → 02 layered compositor
                 ↓
         Final verification (3ch DeckLink soak)
```

Детали, пороги и команды: **doc 07 §§4–6, §17**.

## Hard acceptance (программа)

| Критерий | Порог |
|---|---|
| `in_fps` (3ch, complex) | ≥ 50 |
| `d_pairs` / 5s | высокий (~100–125), не ~0 |
| `d_late` / `d_dropped` | 0 |
| Genlock | locked |
| Visual | OK на reference monitor |
| Headless precondition | `test1` ≥ 45–50 fps → reopen true-50p DeckLink gate |

## Связь с фазами репозитория

| Фаза | Связь с PI07 |
|---|---|
| Phase 15–17 | transform / matrix / raster latency — входные факты |
| Phase 18 | true-50p Fallback; потолок задокументирован; **не** повторять pump-only |
| Phase 19 | Style Guide + cost model ≈ WS-00 / часть WS-01 |
| Phase 6.4 | 8h soak style — для marathon profile в doc 07 |

Точка входа в продукт/ops: `docs/GETTING_STARTED.md`, `docs/RUNBOOK.md`, `.cursor/rules/architecture.mdc`.

## Evidence

Артефакты замеров складывать в:

```
engine/research/results/pi07/<WS>-<YYYYMMDD>/
```

Схема JSON и gate recipes — appendix N/K в doc 07.

## Git workflow

Ветки: `feature/…`, `bench/…`, `docs/…` → PR → **`gh pr merge --merge`** → rollback через `git revert -m 1 <merge-commit>`.  
PR title prefix: `[PI07][WSxx] …` (шаблон — doc 07 §12).

## Быстрые команды

```bash
./bench/run-bench.sh 3 60 5
./engine/run-blink-research.sh
# DeckLink: см. docs/RUNBOOK.md §8 и doc 07 §6
```

## Статус документов

Живой пакет: числа в gate tables обновлять по evidence; **не ослаблять** `late/drop = 0`. Claim «true 50p» в PRODUCT — только после GATE-FV PASS (doc 07).
