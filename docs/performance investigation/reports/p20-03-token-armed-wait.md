# P20.3 — token-armed CEF wait A/B

Дата: 2026-08-09. Verdict: **STOP as standalone cadence fix**.

## Причина эксперимента

Legacy DeckLink loop завершал ожидание по
`paint_seq != last_delivered_seq`. Это publish counter, который может
измениться из-за reuse/cache compose либо late paint предыдущего request.
Treatment сохраняет CEF sequence непосредственно перед
`SendExternalBeginFrame` и завершает wait только при post-send CEF sequence
advance либо через жёсткий one-field timeout. CEF не возвращает request token,
поэтому связь с конкретным BeginFrame остаётся явно `inferred`.

## Реализация

- dev-only `--decklink-token-armed-wait`, default OFF;
- FrameLog v3: `cef_seq_at_send`, `publish_seq_at_send`,
  `wait_exit_reason`;
- bounded decisions: `cef_paint`, `timeout`, `no_request`; бесконечного
  recovery wait нет;
- integrated loopback capture имеет тот же run ID/config digest и measurement
  window;
- перед TAKE harness делает CLEAR ALL, чтобы BGPACING видел ровно один active
  template;
- `p20-test1-marker` объединяет сложный `test1`, красные часы, изображения,
  группы/маски и 64-state SDI marker.

## Отброшенный первый запуск

Первый control/treatment использовал backend channel, где оставался старый
`test1`. Marker визуально работал поверх него, но runtime identity была
неоднозначной (`logical_frame=0`). Эти результаты не являются canonical A/B.
После этого добавлен clear-before-take.

## Clean 60-second A/B

Оба run: one channel, `one_tick`, layered OFF, default 4-ms pump slice,
10-second warm-up, 60-second measurement, TFF loopback port 5→6.

Control:
`/tmp/titulus-p20-token-wait/clean-control-20260809T184351Z/`

- wait exits: 6,485 `legacy_publish`, 15 timeout;
- schedule: 1,499 pair, 0 single, 1 starved, 1 input overwrite;
- semantic: 2,998 decoded fields, one reverse + one skip;
- DeckLink late/drop/flush = 0; producer/frame/runtime liveness PASS.

Treatment:
`/tmp/titulus-p20-token-wait/clean-treatment-20260809T184616Z/`

- wait exits: 6,492 `cef_paint`, 8 timeout;
- schedule: 1,499 pair, 1 single, 0 starved, 0 overwrite;
- semantic: 2,998 decoded fields, one odd-field duplicate;
- DeckLink late/drop/flush = 0; producer/frame/runtime liveness PASS.

Treatment уменьшил честные timeout и убрал overwrite, но не достиг semantic
gate. Единственный duplicate был ближайшим к корректной pair
(`woven_a/woven_b` distinct) и post-send `cef_paint`; attribution поэтому
остаётся `wire_or_field_order_unattributed`, а не объявляется следствием
underflow.

## Решение

Token-armed wait остаётся полезной opt-in коррекцией provenance/false-ready,
но **не продвигается как самостоятельный visual/cadence fix**. Так как 60-s
smoke не дал zero anomaly, 5/15-minute promotion runs не запускаются.

Следующий независимый фактор — absolute 20-ms field grid при том же
token-armed wait contract и 4-ms pump slice. Он проверит Phase 18 eager
sub-tick packing; pump slice, reservoir и системные V8/THP knobs не
смешиваются с этим A/B.
