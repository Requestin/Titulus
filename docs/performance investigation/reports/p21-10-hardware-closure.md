# P21.10 PR-102 — hardware / visual closure

**Дата:** 2026-08-23  
**Хост:** Intel i7-14700KF (`100.73.71.86`), Quad 2 PCIe x4  
**HEAD:** `3999907` (`origin/main` after PR #141)  
**Статус:** automated cadence PASS; operator visual PASS

Это не soak и не formal zero-anomaly on-wire claim.

## Идентичность

| Объект | Ревизия / SHA-256 |
|---|---|
| `origin/main` | `3999907f0138f1b24ee759be1c2b25dc95b32bc2` |
| Engine binary | `c9056983f6c87235f090216b1d38361d4381424b6a1700ebbfb8045c1f9c537b` |
| Runtime bundle | `ee3bac58928691c7373ad141842d11b40b766fdaec3f66105fb23f974f84a50c` |
| `p20-test1-visual` | `d320fe9a82c37e231387f83eacbff6eef3c66f25ad8f464458332e2a77e6478b` |

`layered=OFF`, `one_tick`, provenance ON. Live cells: warmup 10 s,
measurement 225 s, HD1080i50. Media: `p20-test1-{1,2,3}` в
`$TITULUS_DATA/uploads` (копия P21.0 evidence, не боевой `app.db`).

CPU masks: ch1 `0,1,2,3`; ch2 `4,5,6,7`; ch3 `8,9,10,11`.  
Connector map без изменений: port 5 = device 1, port 7 = device 2 visual,
port 9 = device 3 visual.

## Software matrix

См. [p21-10-software-matrix.md](p21-10-software-matrix.md). T0 на этом SHA
зелёный до hardware cells.

## Измерения

| Cell | Pose rate | `(1,1)` / `(2,0)` | late/drop/flush/unlock |
|---|---|---|---|
| Null 1ch | 49.967 | 11242 / 0 | n/a (null) |
| Null 3ch | 49.943 / 49.944 / 49.959 | 100% / 0 | n/a (null) |
| DeckLink 1ch, device 2 | 49.988 | 11247 / 0 | 0 / 0 / 0 / 0 |
| DeckLink 3ch, devices 1–3 | 49.997 / 49.997 / 49.993 | 100% / 0 | 0 / 0 / 0 / 0 |

Delivery/reference в measurement оставались locked. M0 `healthy=false`
только из-за residual `single`/`overwrite`/`starved` — это не late/drop.

## Residual envelope (не шум)

P21.0 DeckLink 3ch x4: ch1 2 `single` + 1 overwrite; ch2 2 `single` +
1 starved + 2 overwrite; ch3 2 `single` + 1 starved + 2 overwrite.

| Cell | Residual в measurement |
|---|---|
| DeckLink 1ch | 2 `single`, 0 overwrite |
| DeckLink 3ch ch1 | 3 `single`, 2 overwrite |
| DeckLink 3ch ch2 | 3 `single`, 1 starved, 3 overwrite |
| DeckLink 3ch ch3 | 3 `single`, 2 overwrite |

3ch residual чуть выше P21.0. Направленной деградации cadence/late/drop нет.
`single`/`overwrite` не объявлены погрешностью и не продвигают strict
on-wire gate.

## Operator visual

Оператор 2026-08-23: «все было ровно» для DeckLink 1ch (порт 7) и 3ch
(порты 5/7/9) на `p20-test1-visual` с медиа. Visual PASS.

## Границы

- Live cell ≤ 5 минут. Phase 20 15/60 min soak не запускались.
- Draft Crawl/action/LayerID fixtures остаются `airCompatible=false`.
- Video air path — WebP ADR (PR #140). PR-81 не открывался.
- Unreal/VS в product trees нет.
- Auth files `token` / `login.json` не являются evidence.

Raw artifacts: `/home/requestin/Titulus-evidence/p21-10/`.
