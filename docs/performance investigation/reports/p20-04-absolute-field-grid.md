# P20.3 — absolute 20-ms field grid A/B

Дата: 2026-08-09. Verdict: **STOP; не продвигается в default**.

## Гипотеза и контракт

После одного DeckLink completion 1080i50 path обычно получает два render
requests. В control второй `BeginFrame` разрешён сразу после раннего paint
первого — это Phase 18 sequential burst packing. Treatment оставляет
`one_tick`, token-armed CEF wait и 4-ms CEF slice неизменными, но ставит второй
request на абсолютную physical-field отметку `batch_anchor + 20 ms`.

`--decklink-absolute-field-grid` — dev-only DeckLink flag, default OFF. Он:

- не затрагивает browser/null/preview/stream;
- даёт slot `0 ms`/deadline `20 ms` для первого field и
  `20 ms`/deadline `40 ms` для второго;
- при late work fail-open: не ждёт ещё один период, пишет
  `field_target_lateness_us` в FrameLog v4;
- harness допускает этот flag только вместе с `--token-armed-wait`, чтобы
  treatment не смешивал известный false-ready contract с grid.

## Clean 60-second A/B

Общие условия: 1ch, output 5/device 1 → loopback input 6/device 2, TFF,
`p20-moving-bar`, layered OFF, three raster threads, `one_tick`,
10-second warm-up, 60-second measurement, token-armed wait, default 4-ms
slice. Оба run имеют healthy metadata/capture/logger/delivery/producer/frame
liveness и zero DeckLink late/drop/flush.

| Вариант | schedule | Semantic fields | Verdict |
|---|---|---|---|
| Control, existing burst packing | 1,500 pair; 3 overwrite | 2,996 decoded; 3 skip | FAIL |
| Treatment, absolute 20-ms grid | 1,499 pair; 1 single; 0 overwrite | 2,998 decoded; 1 odd-field duplicate | FAIL |

Артефакты:

- control: `/tmp/titulus-p20-field-grid/control-20260809T190350Z/`
  (`configDigest=20a9af07a872bc2180f065cff54a0e2674d455428aa17b2e05d6628469147272`);
- treatment: `/tmp/titulus-p20-field-grid/treatment-20260809T190612Z/`
  (`configDigest=42edd593257725a8e9a520e8b8ead90e747f53c11b22792ae397e7aaaf9de384`).

Attribution не нашла оснований приписать ни control skips, ни treatment
duplicate CEF timeout/underflow: ближайшие schedules — `pair` с различными
`woven_a/woven_b`, а frame wait завершался `cef_paint`. Это честно остаётся
`wire_or_field_order_unattributed`.

## Решение

Grid убрал три observed overwrite/skips в коротком прогоне, но не прошёл
строгий zero-anomaly gate: treatment дал один `single` schedule и один
семантический duplicate. Поэтому повторные 5/15-minute runs, visual promotion
и default change запрещены.

Следующий и последний pacing-кандидат из плана — отдельный bounded
one-pair render reservoir. Его нельзя смешивать с grid, pump-slice или
системными knobs; underflow должен fail-open и автоматически делать evidence
FAIL.
