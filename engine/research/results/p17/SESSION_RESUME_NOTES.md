# Phase 17 — заметки для возобновления сессии (8 июля 2026, ~19:45)

**UPDATE (8 июля, ~22:15):** Фаза завершена. После второй перезагрузки
сервера пользователем `ERR_ABORTED` исчез (см. итог ниже). P2-P5 выполнены —
финальные результаты в [p2-raster-threads-ab.md](p2-raster-threads-ab.md),
[p3-verdict.md](p3-verdict.md), [p4-soak-validation.md](p4-soak-validation.md)
и [../../../docs/development-phases/phase-17-raster-latency.md](../../../docs/development-phases/phase-17-raster-latency.md).
Этот файл оставлен как есть — документирует полезный урок про
self-matching `pgrep -f` и диагностику сетевого сбоя после ребута.

## Статус (на момент первой паузы)

Ветка: `feature/phase-17-raster-latency` (не смёржена, PR не создан).
Работа приостановлена пользователем: сервер будет перезагружен ещё раз, чтобы
устранить сетевой баг (см. ниже), затем продолжим.

## Что готово и провалидировано (P0 + P1) — можно доверять этим данным

- **P0 (инструментация) — ЗАВЕРШЕНО, собрано и работает:**
  - `--frame-log=PATH` / `BG_ENGINE_FRAME_LOG` в [engine/src/config.h](../../src/config.h)/[.cpp](../../src/config.cpp)
  - Запись `pump_active_us`/`paint_latency_us`/`waited_deadline` в [engine/src/main.cpp](../../src/main.cpp) (обе pump-ветки: decklink-driven и self-timer)
  - Новый класс [engine/src/frame_log.h](../../src/frame_log.h)/[.cpp](../../src/frame_log.cpp) — буферизованный CSV writer
  - `BG_NUM_RASTER_THREADS` env-override в [engine/src/engine_app.cpp](../../src/engine_app.cpp) → `--num-raster-threads` для renderer
  - `engine/research/analyze-frame-log.mjs` — парсер CSV, считает percentiles + pumpActiveRatio
  - `engine/research/sample-threads.sh` — per-thread CPU сэмплинг (ps -T)
  - `engine/research/run-p17-probe.sh` — оркестрирующий скрипт (запуск + активный renderer PID + сэмплинг + анализ), решает 2 найденные проблемы:
    1. `pgrep -f` самосовпадает с текстом собственной команды-обёртки shell — используем `ps -eo pid,comm,cmd | awk '$2=="bg_engine"'` вместо pgrep -f.
    2. CEF держит 2 renderer-процесса (один почти простаивает — spare/warm), активный определяется по дельте `utime+stime` из `/proc/PID/stat` за ~3с.
  - Сборка `engine/build-p17/` (изолирована от прод `engine/build/`), `BG_ENABLE_DECKLINK=ON`, DeckLink SDK путь передан явно через `-DDECKLINK_SDK_INCLUDE=...`.
  - Всё собрано БЕЗ ошибок (только pre-existing warnings в stb_image_write.h, не связаны с P17).

- **P1 (baseline test1, single channel, cores=0,6,1,7) — ЗАВЕРШЕНО, данные валидны:**
  - Итоговая сводка: [p1-baseline-summary.md](p1-baseline-summary.md)
  - Сырые данные: `baseline-headless-v2-*` (headless, fps=41.25) и `baseline-decklink-*` (device-index=1, fps=40.01)
  - Ключевая находка: `paint_latency_us` в decklink-ветке (p50=20089us) вплотную к границе поля (20мс) — большинство тиков используют весь бюджет. Raster-потоки (`ThreadPoolForeg`) заняты на ~120-142% из 200% макс (2 потока) — не простаивают, но и не насыщены. Смешанная картина A/B, требует P2 A/B для разрешения.

## Что ЗАБЛОКИРОВАНО

**P2 (A/B num-raster-threads)** — данные в `p2-INVALID-post-reboot-network-bug/`
**НЕДЕЙСТВИТЕЛЬНЫ**. Все 6 прогонов (control x3, N=4 x3) показали одинаковые
~4.19 fps независимо от настройки — это сигнатура 200мс engine watchdog
(`Invalidate()` в main.cpp при отсутствии пейнтов), а НЕ реальный рендеринг.

### Причина (найдена и подтверждена)

После первой перезагрузки сервера (среди сессии) **любая HTTP/HTTPS-навигация
в Chromium ломается с `ERR_ABORTED`** — TCP `connect()` успешен (подтверждено
strace: `getsockopt(SO_ERROR) = 0`), но HTTP-запрос **никогда не отправляется**
(нет ни одного `sendto`/`write` на сокет после успешного connect). `file://`
навигация работает штатно (49.9fps на bench-файле).

**Подтверждено, что это НЕ баг Titulus/CEF-кода:**
- Оригинальный немодифицированный `engine/build/Release/bg_engine` (собран 5
  июля, до Phase 17) — тот же `ERR_ABORTED` на `http://example.com/`.
- Системный `google-chrome --headless --no-sandbox` (отдельная, не-CEF сборка
  Chromium) — та же проблема на `http://127.0.0.1:3002/api/health` (нет
  дампа DOM за 10с), при этом `file://` работает мгновенно и корректно.
- Значит: баг на уровне ОС/сети конкретно для Chromium-семейства браузеров,
  не специфичен для нашего кода.

**Что исключено как причина** (проверено с root-доступом, пароль был
предоставлен пользователем для этой сессии, не сохранён никуда):
- iptables/nftables — все цепочки ACCEPT, нет правил, блокирующих loopback/3002 (только Tailscale-related правила, no-op для нашего трафика).
- DNS/resolv.conf — systemd-resolved работает штатно, `curl` резолвит и коннектится мгновенно.
- Proxy — `gsettings` показывает `mode=none`, нет прокси-переменных окружения.
- `kernel.unprivileged_userns_clone=1`, `apparmor_restrict_unprivileged_userns=0` — оба permissive.
- Целостность файлов CEF (icudtl.dat, resources.pak, libcef.so и т.д.) — присутствуют, права нормальные.
- `/dev/shm` — здоров, 7.8G свободно.
- Отдельная (независимая от Titulus/CEF) проблема с правами на `/tmp/titulus-dev` (осталась root-owned от предыдущего `sudo`-запуска `dev-start.sh`) была найдена и **исправлена** (`chown -R requestin:requestin`) — `dev-start.sh` теперь стартует backend+frontend нормально, но это НЕ связано с ERR_ABORTED (тот воспроизводится независимо, включая на внешнем `example.com`).

**Не успели проверить** (нужны более глубокие инструменты/время):
- `chrome://net-export` netlog capture для точной причины отмены запроса на уровне Chromium net-стека.
- `journalctl -k` (kernel audit/seccomp denials) — не было доступа/не проверено полностью.
- Гипотеза: что-то в network service sandbox (seccomp-bpf для утилити-процесса network.mojom.NetworkService) специфично для текущего состояния ядра после ребута.

### Решение пользователя

Пользователь идёт домой и **перезагрузит сервер ещё раз** — это стандартный
шаг диагностики (вдруг разовая гонка при инициализации разрешится повторной
загрузкой). Напишет, когда продолжать.

## Как возобновить работу (чеклист)

1. `cd /home/requestin/Titulus && git status && git branch` — убедиться, что мы всё ещё на `feature/phase-17-raster-latency`, изменения на месте.
2. **Прежде чем запускать что-либо тяжёлое — проверить, не воспроизводится ли ERR_ABORTED:**
   ```bash
   rm -rf /tmp/p17-sanity && mkdir -p /tmp/p17-sanity
   timeout 10 engine/build-p17/Release/bg_engine --name=sanity \
     --url="http://example.com/" --consumer=null --cache-dir=/tmp/p17-sanity \
     --fps=50 --duration=8 --stats-interval=3 2>&1 | grep -E "load error|SUMMARY"
   ```
   Если `fps` в SUMMARY около **~4.2** — баг всё ещё есть, не продолжать P2/P4, разбираться дальше (chrome://net-export, journalctl -k, или снова спросить пользователя).
   Если `fps` ~50 (или хотя бы заметно выше 4.2) — сеть в CEF снова работает, можно продолжать.
3. Если сеть работает — поднять изолированный backend заново (данные на `/tmp` не переживают ребут):
   ```bash
   mkdir -p /tmp/titulus-p17-data
   cd backend && PORT=3003 TITULUS_DATA=/tmp/titulus-p17-data node src/index.js > /tmp/titulus-p17-data/backend.log 2>&1 &
   disown -a
   ```
   Залогиниться (`admin`/`admin123`), загрузить `tests/templates/test1.json` через `POST /api/templates`,
   создать канал через `POST /api/channels`, взять шаблон через `backend/p15-take.mjs <channelId> tests/templates/test1.json <token>`.
4. **Остановить продакшн-каналы пользователя** (тестовые, разрешено использовать/останавливать)
   перед DeckLink-замерами: `pgrep -af "run-engines.sh|run-channel.sh"`, убить супервизоры,
   затем убить оставшиеся `engine/build/Release/bg_engine` процессы (НЕ pkill -f с текстом,
   который может самосовпасть — использовать точные PID).
5. Продолжить с **P2** (A/B `num-raster-threads`, план: `/home/requestin/.cursor/plans/phase_17_—_raster_pool_vs_латентность_0e63c8c0.plan.md`), используя `engine/research/run-p17-probe.sh` — 3 control + 3 N=4 headless прогона по 60с, `--cores=0,6,1,7`.
6. После P2 — P3 (вердикт), P4 (3-канальный DeckLink soak 15 мин), P5 (отчёт + docs + git PR).

## Важно: не восстановлена продакшн-конфигурация каналов

После ребута `/tmp/titulus-dev` (прод-БД, `PORT=3002`) стала **пустой** (новая
SQLite, только seed-админ). Три DeckLink-канала пользователя (device 1/2/3),
которые были настроены раньше, **нужно будет пересоздать через UI**, если
пользователь захочет их вернуть — они не задокументированы в git (это была
ручная настройка через фронтенд). `dev-start.sh` теперь корректно стартует
backend (`:3002`) + frontend (`:3011`), но `run-engines.sh` не поднимет
каналы, пока их нет в БД (это ожидаемо — не баг).
