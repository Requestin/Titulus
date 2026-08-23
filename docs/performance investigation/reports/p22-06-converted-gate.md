# P22.6 — converted-fixture software / DeckLink gate

**Дата:** 2026-08-23  
**Хост:** Intel i7-14700KF (`100.73.71.86`), Quad 2  
**HEAD:** `47a2c1f` (`origin/main` after PR #149)  
**Статус:** automated cadence PASS; operator visual **PENDING**

Это не soak и не formal zero-anomaly on-wire claim. Visual PASS
только после глаз оператора. Residual `single`/`overwrite` не объявлены
шумом.

## Идентичность

| Объект | Ревизия / SHA-256 |
|---|---|
| `origin/main` | `47a2c1f0044dd60e77cf8c4a629b7663bfedb62b` |
| Runtime bundle | `bd15b7656ee4dbcd91d3d48f2144951009111a0bc6ce0081858fc62e565e9ff0` |
| `p20-test1-visual` | `d320fe9a82c37e231387f83eacbff6eef3c66f25ad8f464458332e2a77e6478b` |

Канон cells — уже сконвертированный `tests/templates/p20-test1-visual.json`
(байт-идентичен P21.10). `layered=OFF`, `one_tick`, provenance ON.
Live cells: warmup 10 s, measurement 225 s, HD1080i50.
Media: `p20-test1-{1.jpg,2.png,3.jpg}` в isolated `$TITULUS_DATA/uploads`.

CPU masks: ch1 `0,1,2,3`; ch2 `4,5,6,7`; ch3 `8,9,10,11`.  
Connector map: port 5 = device 1, port 7 = device 2 visual,
port 9 = device 3 visual. Isolated backend: порт 3003.
Боевые 3004/3012 не трогались.

## T0

На `47a2c1f`:

| Suite | Tests | Result |
|---|---:|---|
| runtime `test` + `typecheck` + `build` | 114 | PASS |
| frontend `test` + `typecheck` + `build` | 97 | PASS |
| backend `TITULUS_DATA=/tmp/...` `tests/*.test.mjs` | 140 | PASS |
| root `tests/*.mjs` | 7 | PASS |

## Copied DB + migrate

`backend/tools/migrate-templates.mjs` — только копия, dest не должен
существовать, in-place отказ.

| Source | Dest | templates | rewritten |
|---|---|---:|---:|
| P21.0 `p21-baseline-data/app.db` (каналы, 0 шаблонов) | `/tmp/titulus-p22-6-migrated/app.db` | 0 | 0 |
| Тот же db + 9 seeded fixtures (old `test`/`test1`/`p20-test1-visual` + opened drafts) | `/tmp/titulus-p22-6-scenarios/migrated.db` | 9 | 0 |

`rewritten = 0` ожидаемо: fixtures на диске уже канон после P22.1–P22.4.
После migrate геометрия (`x`/`y`/anchor/`rootStack`) совпала с входом;
повторный `migrateTemplate` идемпотентен. Утилита отказывает in-place и
overwrite — покрыто `backend/tests/migrate-templates-tool.test.mjs`.

## Cells

| Cell | Pose rate | `(1,1)` / `(2,0)` / other | late/drop/flush/unlock |
|---|---|---|---|
| Null 1ch | 49.941 | 11236 / 0 / 0 | n/a (null) |
| Null 3ch | 49.929 / 49.956 / 49.973 | 100% / 0 / 0 | n/a (null) |
| DeckLink 1ch, device 1 | 49.992 | 11247 / 0 / 0 | 0 / 0 / 0 / 0 |
| DeckLink 3ch, devices 1–3 | 49.991 / 50.001 / 50.000 | 100% / 0 / 0 | 0 / 0 / 0 / 0 |

`(2,0)` нигде нет. Unlock в `engine.log` measurement-окна нет.

## Residual envelope (не шум)

| Cell | Residual в measurement |
|---|---|
| DeckLink 1ch | 8 `single`, 1 overwrite, 2 starved |
| DeckLink 3ch ch1 | 3 `single`, 2 overwrite, 4 starved |
| DeckLink 3ch ch2 | 5 `single`, 4 overwrite, 3 starved |
| DeckLink 3ch ch3 | 3 `single`, 2 overwrite, 3 starved |

1ch residual выше P21.10 (там 2 `single`). Cadence/`(2,0)`/late/drop/flush
не деградировали. `single`/`overwrite` не объявлены погрешностью и не
продвигают strict on-wire gate.

## Сценарии (in-process OnAir + prepare)

На сконвертированных / opened fixtures:

| Сценарий | Результат |
|---|---|
| Crawl ticker + carousel одновременно (LayerID 10 и 20) | TAKE обоих |
| Continue после TAKE `timeline-action-cues` | fan-out `continue`, persist/z-order не меняются |
| prepare `onError=block` | `blocked: true`; TAKE → `DATA_BLOCKED` |
| Два шаблона один LayerID 42 | occupant заменён на stack-b |
| WebP in/out окно (inclusive in, exclusive out) + TAKE | 10..39 open; 9 и 40 closed |
| TAKE сконвертированного `p20-test1-visual` | accepted |

## Operator visual

**PENDING.** Оператор ещё не смотрел порты 7 (1ch) и 5/7/9 (3ch) на этом
SHA. Автоматический cadence PASS не заменяет visual PASS.

Пока глаза не подтвердили «ровно, без фризов», P22.6 не закрывает visual
и не открывает P22.7 exam.

## Границы

- Live cell ≤ 5 минут. 15/60 min soak не запускались.
- Unreal/VS / WebM / `videoProgress` не переносились.
- `sampleAt` fast path не удалялся.
- Auth `token` / `login.json` не являются evidence.

Raw artifacts: `/home/requestin/Titulus-evidence/p22-6-converted-gate/`.
