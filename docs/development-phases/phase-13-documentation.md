# Фаза 13 — Переработка документации

## Мета

| Поле | Значение |
|---|---|
| **Статус** | DONE (13a + 13b) |
| **Ветка** | `feature/phase-13-documentation-reworking` |

---

## 1. Цель / зачем

Полностью **переписать документацию и cursor rules**: убрать дубли, единая иерархия источников, фазы в `docs/development-phases/`, язык — русский.

---

## 2. Исходное состояние

- ~6500+ строк дублирующих snapshot/history/spec (`DEVELOPMENT_PROMPT.md`, 10 `.mdc`, разрозненные phase docs)
- Устаревшие ссылки, sandbox policy в rules
- `engine/CASPARRCG_PORTING.md` в engine/ (не docs/)

---

## 3. Scope Phase 13a

- 4 новых rule-файла (3 × `alwaysApply` + 1 optional skills)
- 6 core docs + 14 кратких phase-файлов
- Удаление 14 устаревших `docs/*.md` и 10 старых `.mdc`
- Сжатие package README

**Не трогали:** корневые `README.md`, `LICENSE.md`, `docs archieve/`, `.agents/skills/`, C++ product code.

---

## 4. Scope Phase 13b (расширение)

| Задача | Детали |
|---|---|
| Rules quick-fix | Убрать `broadcast-graphics`, пустые «Следующие задачи», убрать «Текущий фокус» |
| CASPARRCG move | `engine/` → `docs/CASPARRCG_PORTING.md`, обновить ссылки |
| Phase expansion | 14 файлов → 80–300 строк, единый шаблон, таблицы PR #1–#56 |
| ARCHITECTURE.md | 400+ строк — полный тех. справочник |
| Verify | grep paths, `wc -l` |

---

## 5. Реализация

### Итоговая структура rules

```
.cursor/rules/
  architecture.mdc          (alwaysApply)
  development-plan.mdc      (alwaysApply)
  git-workflow.mdc          (alwaysApply)
  skills-map.mdc            (optional)
```

### Итоговая структура docs

```
docs/
  GETTING_STARTED.md
  ARCHITECTURE.md           (400+ строк после 13b)
  RUNBOOK.md
  PRODUCT.md
  DESIGN.md
  CASPARRCG_PORTING.md      (перенесён из engine/)
  development-phases/
    README.md
    phase-00 … phase-13
```

### Удалено (13a)

`AGENT_RESUME.md`, `DEVELOPMENT_PROMPT.md`, `PHASE0_BENCH.md`, `PHASE_REPORT_*`, корневые `phase*.md`, `RUNDOWN_*`, `session-sergey-v1-context.md`, старые `.mdc` (00–11, 99).

---

## 6. PR / Git

| Компонент | Статус |
|---|---|
| Phase 13a rewrite | На ветке `feature/phase-13-documentation-reworking` |
| Phase 13b expansion | Тот же PR (doc-only) |

---

## 7. Критерии приёмки

### 13a

- [x] Один snapshot в `development-plan.mdc`
- [x] Точка входа `GETTING_STARTED.md`
- [x] Фазы 0–13 в `development-phases/`
- [x] Старые docs и rules удалены
- [x] Язык — русский

### 13b

- [x] `architecture.mdc` — 0 `broadcast-graphics`
- [x] `development-plan.mdc` — пустые «Следующие задачи»
- [x] `skills-map.mdc` — без «Текущий фокус»
- [x] `docs/CASPARRCG_PORTING.md` на месте; `engine/` stub отсутствует
- [x] Каждый phase ≥ 80 строк (9, 11 ≥ 200)
- [x] `ARCHITECTURE.md` ≥ 400 строк (556 после 13b)
- [x] Все phase-файлы содержат таблицу PR

### Итоговые размеры (Phase 13b)

| Файл | Строк |
|---|---|
| `docs/ARCHITECTURE.md` | 556 |
| `docs/development-phases/` (сумма) | ~1900 |
| `.cursor/rules/` (4 файла) | ~263 |
| `docs/CASPARRCG_PORTING.md` | 212 |

---

## 8. Рекомендации агентам

При закрытии фазы N+1:

1. Создать/обновить `docs/development-phases/phase-NN-*.md`
2. Обновить таблицу в `development-plan.mdc`
3. При архитектурных изменениях — `architecture.mdc` + `docs/ARCHITECTURE.md`

Точка входа: `docs/GETTING_STARTED.md` → `development-plan.mdc` → phase-документ.

Porting-map: `docs/CASPARRCG_PORTING.md`.

---

## 9. Артефакты

| Путь | Роль |
|---|---|
| `.cursor/rules/` | Agent navigation (4 файла) |
| `docs/development-phases/` | Phase history |
| `docs/ARCHITECTURE.md` | Full technical reference |
| `docs archieve/` | Read-only backup (не редактировать) |
