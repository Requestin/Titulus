# Phase 19 / doc03: zero-copy memory pipeline

## Executive summary

Документ фиксирует результаты работы Phase 19 doc03
по memory pipeline на базе final `main`
после PR #68, PR #69 и PR #70.

Проверка выполнялась на Ryzen 5 3600
с реальными assets `test1`.

Вывод по doc03: частичные gates пройдены.

Instrumentation добавлена.

Копирование `singles` устранено.

Длительные 3-channel soak не показали
late, drop или flush.

Однако программный gate G2 не пройден.

В final default `main` 3-channel `in_fps`
не достигли требуемых значений.

Экспериментальный direct paint устраняет C1,
но не дал надёжного 3-channel throughput uplift.

Поэтому `--decklink-direct-paint` остаётся
выключенным по умолчанию.

Ownership ring не переносится в default path.

Следующее рекомендуемое действие:
doc04, pinning / CCX.

К doc02 следует возвращаться только после doc04,
если G2 всё ещё будет FAIL.

## Setup

База измерений — final `main`
после PR #68, PR #69 и PR #70.

Платформа: Ryzen 5 3600.

Нагрузка: реальные `test1` assets.

Видео-вывод: DeckLink Quad 2.

Genlock находился в состоянии locked.

Основной сценарий — fresh 3-channel baseline.

Частота memory counters — один срез за 5 секунд.

Для baseline серия продолжалась 90 секунд.

Для сравнения PR #69 использовались
короткий 3-channel A/B и 15-minute 3-channel alias soak.

Для PR #70 использовались
1-channel запуск,
30-minute 3-channel direct soak
и 3-channel crossover OFF/ON с тремя повторами.

Final default main проверялся на трёх каналах:
A, B и C.

Дополнительно зафиксированы final null `test1`,
static beacon и `bench3ch`.

## Copy model

PR #68 добавляет `memory5s` instrumentation.

`memory5s` учитывает C1 ring.

`memory5s` учитывает C2 `onframe`.

`memory5s` учитывает clone.

`memory5s` учитывает weave.

`memory5s` учитывает pool hit/miss.

В fresh 3-channel baseline C1 ring
составлял 1.12–1.45 GB за 5 секунд.

В том же baseline C2 `onframe`
составлял 1.12–1.45 GB за 5 секунд.

Clone составлял 0.83–0.96 GB за 5 секунд.

Причина clone: 100–116 `singles`.

Weave составлял около 1.04 GB за 5 секунд.

В 90-second серии pool misses равнялись нулю.

PR #69 меняет модель для `singles` на alias.

После alias `clone bytes/count` равны 0.

После alias `alias_singles=d_singles`.

PR #70 добавляет direct paint path.

В direct path CEF pointer используется
только синхронно внутри `OnFrame`.

`OnFrame` копирует данные в owned queue
до возврата из вызова.

Следовательно, CEF pointer не сохраняется
для последующего асинхронного использования.

Direct paint устраняет C1:
`ring bytes=0`.

## PR1/2/3 results

| PR | Изменение | Измеренный результат | Статус |
| --- | --- | --- | --- |
| #68 | `memory5s`: C1 ring, C2 `onframe`, clone, weave, pool hit/miss | Fresh 3ch: C1 1.12–1.45 GB/5s; C2 1.12–1.45 GB/5s; clone 0.83–0.96 GB/5s; weave ~1.04 GB/5s | Instrumentation available |
| #69 | `singles` alias | `clone bytes/count=0`; `alias_singles=d_singles`; short A/B median 3ch `in_fps` 27.6→29.0 | Clone removed |
| #70 | `--decklink-direct-paint` / `BG_DECKLINK_DIRECT_PAINT` | C1 eliminated (`ring bytes=0`), но надёжный 3ch throughput uplift не подтверждён | Experimental, OFF by default |

### PR #68 — instrumentation

PR #68 добавляет наблюдаемость memory pipeline.

Счётчики снимаются как `memory5s`.

Они покрывают ring C1.

Они покрывают `OnFrame` C2.

Они покрывают clone.

Они покрывают weave.

Они покрывают pool hit/miss.

Fresh 3ch baseline показал
C1 ring 1.12–1.45 GB/5s.

Он же показал
C2 `onframe` 1.12–1.45 GB/5s.

Clone составил 0.83–0.96 GB/5s.

Число `singles` составляло 100–116.

Weave составил примерно 1.04 GB/5s.

За 90 секунд pool misses не было.

### PR #69 — singles alias

PR #69 заменяет clone для `singles`
на alias.

После изменения `clone bytes/count=0`.

После изменения `alias_singles=d_singles`.

В коротком 3ch A/B median `in_fps`
изменился с 27.6 до 29.0.

15-minute 3ch alias soak не показал
late, drop или flush.

В этом soak clone оставался равным 0.

Input pool misses не превышали 2.

На каждом канале было примерно
17k–19k input pool hits.

Наблюдаемая miss rate была менее 0.1%.

### PR #70 — direct paint

PR #70 вводит флаг `--decklink-direct-paint`.

Эквивалентная env-переменная:
`BG_DECKLINK_DIRECT_PAINT`.

CEF pointer применяется только синхронно
внутри `OnFrame`.

До возврата `OnFrame` выполняет копирование
в owned queue.

В 1ch direct получено 50 `in_fps`.

30-minute 3ch direct soak показал
`ringB=0`.

Тот же soak показал
`cloneB=0`.

В нём `late=0`.

В нём `drop=0`.

В нём `flush=0`.

В нём не было наблюдаемых crash/corruption; pointer lifetime по дизайну
ограничен синхронным `OnFrame` копированием. Это soak-evidence, не
формальное доказательство отсутствия всех UAF-классов.

3ch crossover OFF/ON, повтор A:
29.7 → 29.6.

3ch crossover OFF/ON, повтор B:
28.1 → 27.1.

3ch crossover OFF/ON, повтор C:
30.3 → 30.4.

Эти три повтора не подтверждают
надёжный 3ch throughput uplift.

## Final gates

| Gate / проверка | Наблюдение | Итог |
| --- | --- | --- |
| Clone elimination | Final default main: `clone=0` | PASS |
| Pool behaviour | Miss rate <0.1% в alias soak; pools не менялись | PASS for observed data |
| Direct ownership safety | 30m direct 3ch: `ringB=cloneB=0`, `late/drop/flush=0`, no UAF | PASS for observed soak |
| Default 3ch throughput | A=27.6, B=28.0, C=30.8 `in_fps` | G2 FAIL |
| Program G2 | Требование: 3× `in_fps >=50` / high pairs | FAIL |
| Null regression | final null `test1` 49.79; static beacon 50; `bench3ch` average 49.95 | No browser/null regression |

В final default main A имеет 27.6 `in_fps`.

В final default main B имеет 28.0 `in_fps`.

В final default main C имеет 30.8 `in_fps`.

Для A pairs равны 13.

Для B pairs равны 15.

Для C pairs равны 29.

Для A `singles` равны 113.

Для B `singles` равны 110.

Для C `singles` равны 96.

Final default main имеет `late=0`.

Final default main имеет `drop=0`.

Final default main сохраняет `clone=0`.

Final C1 ring составляет 1.15–1.29 GB/5s.

Final C2 `onframe` составляет 1.15–1.29 GB/5s.

Final weave составляет 1.045 GB/5s.

Программа G2 требует
3× `in_fps >=50` / high pairs.

По этому критерию G2 — FAIL.

Final null `test1` равен 49.79.

Static beacon равен 50.

`bench3ch` average равен 49.95.

Эти контрольные результаты не показывают
browser/null regression.

## Rejected and deferred decisions

Direct paint не становится default mode.

Причина: не подтверждён надёжный
3-channel throughput uplift.

Флаг остаётся experimental.

Default для флага остаётся OFF.

Ownership ring для default path отложен.

Причина отсрочки: сложность решения
при отсутствии измеренного преимущества.

В текущем объёме работы pools не изменялись.

Данные показывают miss rate менее 0.1%.

`MADV_HUGEPAGE` явно не attempted.

`MADV_HUGEPAGE` не merged.

## Raw artifacts

Краткий список raw artifacts:

`engine/research/results/p19/doc03-20260714/`

Логи и CSV в этом пути ignored.

`memory-summary.json` и `final-bench3ch.txt` tracked вместе с этим отчётом;
полные raw logs/CSV остаются gitignored по policy репозитория.

## Conclusion and next action

Phase 19 doc03 PASS по частичным gates.

К ним относятся instrumentation,
устранение clone
и результаты длительных soak.

Работа не снимает program block.

G2 остаётся FAIL в final default main.

Direct mode является experimental flag.

Direct mode не является default configuration.

Следующее рекомендуемое действие — doc04:
pinning / CCX.

Doc02 следует рассматривать после doc04
только если G2 останется FAIL.

## Rollback

Изменения данной документации можно откатить
через `git revert <merge-commit>`.

Rollback PR #68, PR #69 и PR #70
должен выполняться их соответствующими commits,
если потребуется откатить code changes.
