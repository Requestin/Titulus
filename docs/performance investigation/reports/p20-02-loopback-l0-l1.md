# P20.2 — Quad 2 loopback L0/L1 evidence

Дата: 2026-08-09. Verdict: **L0 PASS; L1 STOP/pending**.

Это evidence физического SDI-выхода, а не продолжение Phase 19 throughput
gate. Средний `in_fps`, DeckLink completion result и monitor impression не
заменяют semantic field sequence.

## Стенд и connector map

- DeckLink Quad 2, Full Duplex, Desktop Video/SDK 16.0;
- `HD1080i50`, `fill_only`, Reference In постоянно подключён к физическому
  порту 1;
- Titulus output: `device-index=1` = порт 5;
- capture input: `device-index=2` = порт 6;
- кабель: порт 5 → порт 6, без SDI loop;
- полевая интерпретация: TFF.

## L0

SDK TestPattern на output device 1 и SDK Capture на input device 2 дали
250/250 валидных UYVY frames за 10 секунд. Input lock и геометрия
`1920×1080i50` подтверждены. Статический pattern не определяет temporal field
dominance, поэтому L0 не использовался как cadence proof.

## L1 capture probe

Добавлен observer-only `decklink_field_capture`:

- получает UYVY frame в `VideoInputFrameArrived`;
- вызывает `StartAccess(bmdBufferAccessRead)` до `GetBytes` и `EndAccess`
  после decode;
- декодирует оба поля без записи raw video;
- пишет field index, semantic ID, parity и hash;
- не планирует output frames и не меняет DeckLink profile.

Synthetic decode unit и semantic duplicate/skip/reverse fixtures проходят.
BFF control дал примерно 748 reverse и 748 skip на 1,496 fields. TFF сохраняет
правильное направление и является единственной допустимой интерпретацией для
этого стенда.

## Результаты one-tick

Короткие TFF smoke показывали от нуля до нескольких duplicate и доказали, что
probe способен декодировать все поля. Они не являются acceptance.

Пяти-минутный run
`/tmp/titulus-p20-l1/slice1ms-5m-20260809T171753Z/`:

- `pacing_mode=one_tick`;
- `pumpSliceUs=1000`;
- 14,998/14,998 decoded fields;
- duplicate = 71, все на odd field;
- skipped = 1;
- reversed = 1;
- parity mismatch / undecodable = 0;
- DeckLink late/drop/flush = 0;
- engine totals: pairs 9,164, singles 81, starved 4, overwrite 3.

Следовательно, 1-ms pump slice уменьшает service latency, но не обеспечивает
чистую on-wire cadence и не является fix candidate.

## Отклонённый serial recovery

Наивный режим «после miss не отправлять следующий BeginFrame до late paint»
прошёл короткий 60-s smoke (2,996 чистых fields), но длинные runs выявили
неограниченное ожидание:

- один run: `in=0`, pairs 0, starved 9,270, 14,996 undecodable frozen fields;
- confirm: оператор увидел стоп-кадр, часы остановились на `20:35:23`;
- DeckLink late/drop/flush при этом оставались нулевыми.

Режим полностью откатан. Он доказал, что completion-health без producer
liveness может дать ложный PASS.

## Evidence hardening

P20 verifier теперь разделяет:

1. logger integrity;
2. DeckLink delivery health;
3. producer/render liveness;
4. post-warm-up pair/single/starved cadence;
5. semantic-field acceptance.

Strict semantic gate требует ненулевую декодированную выборку и zero
duplicate/skip/reverse/undecodable/parity mismatch. Joint verdict проходит
только при PASS всех плоскостей. Canonical harness завершает всю process group
bounded TERM→KILL и сохраняет `run-status.json`, поэтому abort или оставшийся
CEF child не может считаться graceful evidence.

## Следующий gate

После merge tooling PR повторить canonical TFF L1 baseline:

1. 60-s smoke;
2. два независимых 5-min captures;
3. 10–15-min L2 только после двух PASS.

Любая semantic anomaly, steady-state single/starved/overwrite, producer stall,
DeckLink error или reference unlock означает STOP. Первый pacing A/B должен
исправить wait identity по реальному CEF paint sequence; абсолютная 20-ms
field grid проверяется отдельным фактором после него.
