# Runbook — операционка Titulus

Ubuntu 24.04+. Быстрый старт: `docs/GETTING_STARTED.md`. Архитектура: `docs/ARCHITECTURE.md`.

## 1. Зависимости

```bash
sudo apt-get update
sudo apt-get install -y \
  git curl jq ffmpeg python3 build-essential cmake pkg-config \
  libx11-dev libxcomposite-dev libxdamage-dev libxrandr-dev libxext-dev \
  libglib2.0-dev libnss3-dev libatk1.0-dev libatk-bridge2.0-dev libcups2-dev \
  libxkbcommon-dev libdrm-dev
```

Node.js 20+ (пример через nvm):

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.nvm/nvm.sh && nvm install 20 && nvm use 20
```

## 2. Bootstrap

```bash
git clone https://github.com/Requestin/Titulus.git && cd Titulus
cd runtime && npm install && npm run build && cd ..
cd backend && npm install && cd ..
cd frontend && npm install && cd ..
```

## 3. Сборка bg_engine

```bash
./engine/third_party/fetch-cef.sh
cd engine && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j"$(nproc)" && cd ..
```

С DeckLink (если есть SDK):

```bash
cd engine && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
  -DBG_ENABLE_DECKLINK=ON \
  -DDECKLINK_SDK_INCLUDE="/path/to/Blackmagic DeckLink SDK/Linux/include" \
  && cmake --build build -j"$(nproc)" && cd ..
```

## 4. Dev-стек

```bash
./dev-start.sh    # :3011 / :3002
./dev-stop.sh
```

Health: `curl -s http://127.0.0.1:3002/api/health`

Только localhost: `TITULUS_HOST=127.0.0.1 ./dev-start.sh`

**Важно:** для тестов backend задавайте `TITULUS_DATA=/tmp/titulus-...`, не `./data` в репо.

Запуск backend вручную (без subshell `( )`):

```bash
cd backend && PORT=3002 TITULUS_DATA=/tmp/titulus-dev node src/index.js
```

Остановка: PID по порту — `ss -ltnp | grep ':3002'`, затем `kill <pid>`. Не `pkill -f "PORT=3002"`.

## 5. Auth

- Логин: `admin` / `admin123`
- Token: `POST /api/auth/login` с JSON `{"username":"admin","password":"admin123"}`
- Заголовок: `Authorization: Bearer <token>`

## 6. Каналы и engines

Settings UI (`/settings`, admin) или REST `/api/channels`.

```bash
BACKEND_URL=http://127.0.0.1:3002 \
TITULUS_API_USER=admin TITULUS_API_PASSWORD=admin123 \
./engine/run-engines.sh --dry-run

BACKEND_URL=http://127.0.0.1:3002 \
TITULUS_API_USER=admin TITULUS_API_PASSWORD=admin123 \
./engine/run-engines.sh
```

Для исследования packing можно явно выбрать L3-aware планировщик:

```bash
TITULUS_PACK=ccx \
BACKEND_URL=http://127.0.0.1:3002 \
TITULUS_API_USER=admin TITULUS_API_PASSWORD=admin123 \
./engine/run-engines.sh --dry-run
```

`sequential` остаётся default. Planner всегда включает SMT siblings и
останавливает запуск при нехватке physical cores; не заменяйте это ручным
`taskset -c 0-3`.

## 7. Smoke

- Validate: `POST /api/templates/validate`
- Stream: `ffplay "srt://127.0.0.1:9999?mode=listener"`
- Bench: `./bench/run-bench.sh 3 20 5`
- Rundown: `/control` → вкладка Rundowns, PREV/TAKE/NEXT, hotkeys

## 8. DeckLink (HW-хост)

**Перед экспериментами:** `pgrep -af "bg_engine|run-channel|run-engines"`

Домашний стенд (Quad 2): genlock на Reference In; монитор на **SDI #3**; `--device-index=1`, `HD1080i50`. Подробности — `docs/development-phases/phase-06-saas-decklink.md`.

```bash
./engine/build/Release/bg_engine \
  --consumer=decklink --device-index=1 --display-mode=HD1080i50 \
  --keyer=fill_only --fps=50 --url=file:///tmp/test_pattern.html \
  --cache-dir=/tmp/bg_smoke --duration=60
```

Evidence: `OUT_ROOT=/var/log/titulus ./engine/collect-decklink-evidence.sh`

`SCHED_FIFO` для decklink — soft-fail без `CAP_SYS_NICE`; для prod — systemd `LimitRTPRIO`.

Для одного уже запущенного 3-channel doc04 soak собрать изолированный bundle:

```bash
./engine/research/p19/collect-doc04-evidence.sh \
  --out-dir=/tmp/titulus-doc04-evidence \
  --logs-dir=./logs
```

Collector берёт host-wide lock, но не запускает, не останавливает и не меняет
affinity engine-процессов. Не запускайте второй DeckLink soak параллельно:
на Ryzen 5 3600 все шесть physical cores уже заняты 3×2c packing.

Doc02 layered compositor (global default off; production allowlist only):

```bash
export BG_LAYERED_COMPOSITOR=1
export BG_LAYERED_COMPOSITOR_ALLOWLIST=6104dc7e-45c4-48b1-a382-db3b3b34091f

# Paired gate harness (expects doc04 channel setup + token):
engine/research/p19/run_doc02_k2_abba.sh 1ch 30
engine/research/p19/run_doc02_k2_abba.sh 3ch 30
```

Before accepting a channel, require startup `layered=on`, `allowlist=1` and
periodic `layered_stats mode=composing capture_failures=0 fallback=0`.
`capture_ready` must cover all eight canonical pixel sources and compose p95
must stay ≤3 ms. DeckLink telemetry must have zero late/drop/flush/unlock.

Immediate rollback:

```bash
export BG_LAYERED_COMPOSITOR=0
unset BG_LAYERED_COMPOSITOR_ALLOWLIST
# restart the affected run-channel/bg_engine process
```

Rollback has no migration or cache cleanup requirement. Flag-off restores the
legacy monolith `OnPaint → FrameRing` path. Unsupported/non-allowlisted graphs
also fall back automatically and must never produce approximate mixed output.

## 9. Blink research (bench)

```bash
./engine/run-blink-research.sh
./engine/run-blink-internals-research.sh
```

Флаги engine: `--blink-research=1|2`, `--remote-debugging-port=N`

## 10. Troubleshooting

| Симптом | Решение |
|---|---|
| SQLITE_IOERR | `TITULUS_DATA=/tmp/...` |
| 401 API | Нет/просрочен token |
| 403 | Нужна роль admin |
| run-engines не видит channels | Token или user/password env |
| stream restart loop | Проверить `stream_url`, ffmpeg, firewall |
| EnableVideoOutput failed | device-index занят другим процессом |
| Live каналы не останавливаются | Убить дерево: run-engines + run-channel + bg_engine |
| renice не откатывается | Нужен sudo для снижения nice |
| CEF OnPaint остановился | Проверить perpetual rAF + beacon в channel.html |

Остановить live-канал полностью: убить supervisor `run-engines.sh` и все `run-channel.sh`, не только `bg_engine` (supervisor перезапустит через ~3с).

## 11. Логи dev

`logs/dev/backend.log`, `logs/dev/frontend.log`, `logs/dev/engines.log`
