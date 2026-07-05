# Продукт Titulus

## Пользователи

Операторы live-эфира, графические операторы и режиссёры в ТВ-галереях и удалённых control room. Контекст: тусклое помещение, высокое давление времени, 2–8 каналов одновременно. Задача: вывести нужный титр в нужный момент, обновить live, снять чисто — без опозданий и ошибок.

## Назначение

Titulus — коммерческая облачная и on-prem система broadcast-графики. Control plane: JSON-шаблоны, rundown-сценарии, TAKE/UPDATE/CLEAR. Render: proprietary CPU-only CEF-движок с parity CasparCG по эфиру.

**Успех:** многочасовой эфир без пропущенных график; картинка неотличима от CasparCG на том же железе; preview редактора = эфир (`@titulus/runtime`, WYSIWYG).

## Выходы

Browser, OBS/vMix browser source, DeckLink SDI, SRT/RTMP stream — per channel.

## Rundown

Пошаговый сценарий: слоты с `slotId`, transport PREV/TAKE/NEXT. Один шаблон может быть в эфире несколько раз через разные слоты.

## Характер бренда

Точный, спокойный под давлением, broadcast-grade. Инструмент, не игрушка. Три слова: **точность, собранность, надёжность**.

## Анти-референсы

- Consumer SaaS: пастель, иллюстрации, metric-cards
- Skeuomorphic «pro audio» chrome
- Игривый bubbly UI
- Неоднозначное on-air состояние — если оператор не видит LIVE с первого взгляда, дизайн провален

## Принципы

- **Glanceability** — состояние канала за <1 сек в тёмной комнате
- **On-air truth** — LIVE = однозначный красный tally
- **WYSIWYG** — editor canvas = program output
- **Earned familiarity** — конвенции OBS/vMix/Resolve/CasparCG Client
- **Плотность без шума** — только нужное оператору

## Доступность

WCAG 2.2 AA для web control plane. Полная клавиатура для TAKE/UPDATE/CLEAR. `prefers-reduced-motion`. `tabular-nums` для таймкода и счётчиков.
