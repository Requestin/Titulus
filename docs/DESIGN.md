# Дизайн control plane

Визуальная система frontend/. Тёмная тема control room. Токены: `frontend/src/index.css`, Tailwind: `frontend/tailwind.config.js`. Для UI-задач — skill `impeccable` + `docs/PRODUCT.md`.

## Тема

Только тёмная. Галерея ночью: near-black поверхности, один насыщенный сигнал — LIVE red.

## Цвет (OKLCH)

Поверхности:
- `--bg`, `--surface`, `--surface-2`, `--border`, `--overlay`

Текст: `--ink`, `--ink-muted`, `--ink-faint`

Бренд: `--primary`, `--primary-ink`, `--ring`

Семантика: `--live`, `--success`, `--warning`, `--danger`, `--info`

Токены — bare `L C H`, в Tailwind: `oklch(var(--token) / <alpha>)`.

## Типографика

Inter Variable — весь UI. Mono — только цифры.
- Шкала ~1.2: 12/13/14/16/20/24 px, default 14px
- Таймкод, fps, номера каналов: `font-mono` + `tabular-nums`

## Компоненты

- Кнопки: primary, neutral, ghost, danger/live для TAKE/CLEAR ALL
- Inputs: surface-2, border hairline, focus ring
- Панели: flat, разделение `--border`, без nested cards
- Channel pill: idle → preview (info) → LIVE (solid `--live`, без мигания)
- WS status dot: connected / connecting / disconnected
- Empty states — следующее действие; loading — skeleton

## Layout

- Shell: left nav, top bar + WS, scroll content
- Editor: Layers | Canvas 16:9 | Properties/Variables | Timeline
- z-index: base < sticky < dropdown < modal < toast < tooltip

## Motion

150–220 ms ease-out. TAKE/CLEAR, value pop-in, panel collapse. Без page-load choreography. `prefers-reduced-motion` → crossfade/instant.

Анимация на channel.html (timeline) — в `@titulus/runtime`, отдельно от chrome rules.
