# P22.7 — operator templates + Phase 22 close

**Дата:** 2026-08-24  
**Хост:** Intel i7-14700KF (`100.73.71.86`), Quad 2  
**HEAD фикстур:** `904a218` (PR #156)  
**Статус:** DONE — оператор закрыл P22.7 и Phase 22

Финальный exam Phase 22 — новые шаблоны оператора, не музейный `test1`.
Оператор принял набор и закрыл фазу 2026-08-24. Строгий on-wire
zero-anomaly claim по-прежнему отложен.

## Набор

| Case | JSON | Сцена |
|---|---|---|
| `newtest1` | `tests/fixtures/p22/operator/newtest1.json` | без видео |
| `newtest2` | `tests/fixtures/p22/operator/newtest2.json` | с видео (два looped WebP) |

Медиа: `tests/fixtures/p22/operator/media/` + `seed-media.sh`.  
Air path видео — только WebP. Source `.webm` — архив, в эфир не копируется.  
Goldens: `tests/fixtures/p22/expected/newtest{1,2}.{normalized,capabilities}.json`.  
`backend/tests/p22-operator-fixtures.test.mjs`: 10/10.

Канон для **новых** performance cells — только эти два шаблона.
Музейный `p20-test1-visual` остаётся историей P20/P21/P22.6.

## P22.6 (музей, уже в main)

Отчёт: `p22-06-converted-gate.md`. Null/DeckLink 1ch/3ch на
сконвертированном `p20-test1-visual`: `(2,0)=0`, late/drop/flush = 0,
pose ≈ 50.0. Visual принят оператором при закрытии фазы.

## 15m 3ch DeckLink на `newtest2`

Evidence: `/home/requestin/Titulus-evidence/p22-newtest2-3ch-15m`  
Harness: `run-p20-cell.sh` 3ch, `one_tick`, layered OFF, raster 3,
devices 1/2/3, CPU `0-3 / 4-7 / 8-11`, measure 900.003 s, warmup 10 s.
TAKE на все три канала: `759d1ec8-d83a-4f2f-bada-127d7f5cea45`.
Outcome: `completed` / `graceful`. Медиа 404 не было.

| ch | pose | `(1,1)` | `(2,0)` | late/drop/flush | meas single | meas overwrite | meas starved |
|---|---:|---:|---:|---|---:|---:|---:|
| 1 | 49.710 | 44739 | 0 | 0/0/0 | 261 | 3 | 1 |
| 2 | 49.890 | 44901 | 0 | 0/0/0 | 116 | 23 | 3 |
| 3 | 49.877 | 44888 | 0 | 0/0/0 | 118 | 15 | 4 |

P22-gate (pose ≥ 49.5, `(2,0)=0`, late/drop/flush = 0): PASS.  
`one_tick` держится. DeckLink delivery чистый. Pose ниже музейных 50.0 —
стоимость двух looped WebP (один с `lighten`). Residual
`single`/`overwrite`/`starved` записаны и **не** объявлены шумом.
Строгий M0 `cadenceHealth` из-за них красный; это не блокер visual close.

Короткий T0 + null 1ch/3ch + DeckLink 1ch на `newtest*` отдельно не
переснимались: оператор закрыл фазу по этому набору и 15m 3ch soak.

## Закрытие

Phase 22 закрыта. Новая схема — канон продукта. `supported[]` открыт
по проверенным capability. Unreal / Sergey engine / WebM в `main` нет.

Следующая работа — вне этого документа, по новой задаче оператора.
Engine-first rule и deferred on-wire gate остаются в силе.
