# P20.3 — bounded one-pair reservoir

Дата: 2026-08-09. Verdict: **STOP; pacing-патчи завершены**.

## Контракт treatment

После STOP absolute field grid проверен единственный разрешённый fallback:
`--decklink-one-pair-reservoir`.

Он держит в input queue максимум две будущие unique poses — ровно одну
interlaced pair. Если callback видит меньше двух, он ждёт producer не более
4 ms. По deadline происходит fail-open в существующий single/starved path, а
`reservoir_underflow` записывается в DeckLink event CSV и автоматически
ломает M0 cadence gate. Flag требует token-armed wait, несовместим с field
grid и выключен по умолчанию.

## 60-second smoke

Условия: 1ch, output 5/device 1 → loopback input 6/device 2, TFF,
`p20-moving-bar`, layered OFF, three raster threads, `one_tick`,
token-armed wait, 10-second warm-up и 60-second measurement.

Артефакт:
`/tmp/titulus-p20-one-pair-reservoir/treatment-20260809T191155Z/`
(`configDigest=a89b11e93d357fcb2f4d2d5bfa4e28f92b15b3b70d1ab45c78a0b6d97e7e3e31`).

- healthy: metadata, capture binding/summary, logger, delivery,
  producer/frame liveness; DeckLink `late/drop/flush=0`;
- cadence: 1,497 `pair`, 3 `single`, zero overwrite, 3 explicit
  `reservoir_underflow`;
- semantic: 2,998 decoded fields, 3 duplicates;
- joint verdict: FAIL.

## Решение

Резервуар не устранил underflow: он только честно сделал три недостатка
второй позы наблюдаемыми и совпадающими с тремя semantic duplicates. Поэтому
ни 5/15-minute promotion, ни visual promotion, ни default change не
допускаются.

Два независимых timing-кандидата — absolute grid и one-pair reservoir — не
дали zero-anomaly 60-s smoke. В соответствии с Phase 20 дальнейший перебор
pacing retries прекращён: текущая CEF OSR/DeckLink path не доказал чистую
on-wire cadence при этих ограничениях. Далее Phase 20 разделяет residual
microfreeze detector и внешние факторы (M1/M2), не добавляя новых
timing-патчей.
