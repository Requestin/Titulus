# Titulus Runbook (Ubuntu 24.04+)

Operational setup and run flow for Titulus control plane + render plane.

## 1. Prerequisites

Install system dependencies:

```bash
sudo apt-get update
sudo apt-get install -y \
  git curl jq ffmpeg python3 build-essential cmake pkg-config \
  libx11-dev libxcomposite-dev libxdamage-dev libxrandr-dev libxext-dev \
  libglib2.0-dev libnss3-dev libatk1.0-dev libatk-bridge2.0-dev libcups2-dev \
  libxkbcommon-dev libdrm-dev
```

Install Node.js 20+ (example with `nvm`):

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.nvm/nvm.sh
nvm install 20
nvm use 20
```

## 2. Clone and bootstrap

```bash
git clone https://github.com/Requestin/Titulus.git
cd Titulus
```

Install package dependencies:

```bash
cd runtime && npm install
cd ../backend && npm install
cd ../frontend && npm install
cd ..
```

Build runtime bundle:

```bash
cd runtime && npm run build
cd ..
```

## 3. Build `bg_engine`

Fetch CEF (one-time):

```bash
./engine/third_party/fetch-cef.sh
```

Build:

```bash
cd engine
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j"$(nproc)"
cd ..
```

Optional DeckLink-enabled build (when SDK headers are available):

```bash
cd engine
cmake -S . -B build \
  -DCMAKE_BUILD_TYPE=Release \
  -DBG_ENABLE_DECKLINK=ON \
  -DDECKLINK_SDK_INCLUDE="/path/to/Blackmagic DeckLink SDK/Linux/include"
cmake --build build -j"$(nproc)"
cd ..
```

## 4. Start stack (recommended dev flow)

One-command startup:

```bash
./dev-start.sh
```

Default endpoints:

- frontend: `http://127.0.0.1:3011`
- backend: `http://127.0.0.1:3002`
- LAN frontend: `http://<this-host-LAN-IP>:3011` (for another computer on the same network)

Health check:

```bash
curl -s http://127.0.0.1:3002/api/health
```

By default `dev-start.sh` binds the dev servers to `0.0.0.0` so the UI is reachable
from another computer on the LAN. To force localhost-only mode:

```bash
TITULUS_HOST=127.0.0.1 ./dev-start.sh
```

## 5. Authentication baseline

Default bootstrap credentials:

- username: `admin`
- password: `admin123`

Get token:

```bash
curl -s -X POST http://127.0.0.1:3002/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"admin123"}'
```

Use bearer token for protected API calls:

```bash
TOKEN="<token>"
curl -s http://127.0.0.1:3002/api/channels -H "Authorization: Bearer ${TOKEN}" | jq
```

## 6. Configure channels

Preferred: Settings UI (`/settings`, admin only).

REST example (`stream` mode):

```bash
curl -s -X POST http://127.0.0.1:3002/api/channels \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{
    "name":"Ch1",
    "output_mode":"stream",
    "device_index":-1,
    "display_mode":"HD1080i50",
    "keyer_mode":"external",
    "stream_url":"srt://127.0.0.1:9999?mode=caller"
  }'
```

## 7. Start render plane

Dry-run:

```bash
BACKEND_URL=http://127.0.0.1:3002 \
TITULUS_API_USER=admin \
TITULUS_API_PASSWORD=admin123 \
./engine/run-engines.sh --dry-run
```

Launch:

```bash
BACKEND_URL=http://127.0.0.1:3002 \
TITULUS_API_USER=admin \
TITULUS_API_PASSWORD=admin123 \
./engine/run-engines.sh
```

Single-channel manual run:

```bash
./engine/run-channel.sh \
  --id=<channel-id> \
  --name="Channel 1" \
  --output-mode=stream \
  --stream-url="srt://127.0.0.1:9999?mode=caller"
```

## 8. Smoke checks

### 8.1 Template validation

```bash
curl -s -X POST http://127.0.0.1:3002/api/templates/validate \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"id":"t","name":"T","canvas":{"width":1920,"height":1080,"background":"transparent"},"variables":[],"groups":[],"layers":[],"rootStack":[],"groupStacks":{},"timeline":{"fps":50,"durationFrames":1,"playbackMode":"bounded","directors":[{"id":"d","name":"D","durationFrames":1,"offsetFrames":0,"autostart":true,"loop":false,"swing":false}],"trackDirectors":{},"keyframes":[],"actions":[]}}'
```

### 8.2 Stream output

Receiver:

```bash
ffplay "srt://127.0.0.1:9999?mode=listener"
```

### 8.3 Upload/transcode

```bash
curl -s -X POST http://127.0.0.1:3002/api/uploads \
  -H "Authorization: Bearer ${TOKEN}" \
  -F 'file=@/path/to/video.mp4;type=video/mp4'
```

### 8.4 Rundown v2 (slot-aware) smoke

1. Открой `http://127.0.0.1:3011/control`, вкладка `Rundowns`.
2. Создай rundown, добавь 2+ slot'а (можно с одним и тем же template).
3. Назначь channel binding (или оставь default).
4. Проверь transport:
   - `PREV` / `NEXT` фокусируют и TAKE-ят соответствующий slot,
   - `Space` = TAKE focused slot + переход к следующему,
   - `ArrowUp/ArrowDown` меняют фокус,
   - `Delete/Backspace` clear focused on-air slot.
5. Разверни slot и измени vars — для on-air slot изменения должны уйти как `update`.
6. Reload страницы: on-air статус slot'ов должен восстановиться из `/api/onair`.

REST smoke для rundown API:

```bash
curl -s http://127.0.0.1:3002/api/rundowns \
  -H "Authorization: Bearer ${TOKEN}" | jq

curl -s http://127.0.0.1:3002/api/rundowns/<id> \
  -H "Authorization: Bearer ${TOKEN}" | jq
```

## 9. DeckLink hardware validation handoff

For final SDI acceptance (Phase 6.4), use:

- `docs/phase6-decklink-validation-closure.md`
- `docs/phase6-decklink-host-diagnose.md` — **home-host diagnose results**, canonical Quad 2 connector numbering, and verified `device_index` mapping
- `docs/phase11-baseline.md` — CasparCG-parity perf pass (clock/memory/OS), validated live on the same home host: 3 simultaneous SDI outputs confirmed on profile `1dfd` (an earlier "2-output limit" hypothesis during that investigation was retracted), 28.6-minute 3-channel soak with 0 dropped/flushed/late frames
- `engine/collect-decklink-evidence.sh`

**Before any hardware experiment on this host:** run `pgrep -af "bg_engine|run-channel|run-engines"` first — live channels may already be running (test stand or air), possibly started well before your session and kept alive across engine restarts by the `run-channel.sh` supervisor loop.

**Home dev host (Quad 2, 2026-07-02):** sync generator on Reference In (closest mini-DIN to MB); SDI monitor on **physical SDI #3**; engine flag `--device-index=1`, `HD1080i50`, `fill_only`. See diagnose doc for connector layout and smoke command.

**Real-time scheduling (Phase 11.4):** `bg_engine` requests `SCHED_FIFO` priority 2 on the render pump thread when running a DeckLink-driven channel (soft-fails without `RLIMIT_RTPRIO`/`CAP_SYS_NICE` granted — normal on an unprivileged service account, logs once and continues at normal priority). To enable it in production, grant the capability at the deployment level (e.g. a systemd unit with `LimitRTPRIO=2`, or an `/etc/security/limits.d` entry) — not done automatically by the codebase since it's a system-wide security-policy change.

Evidence bundle example:

```bash
OUT_ROOT=/var/log/titulus \
BACKEND_URL=http://127.0.0.1:3001 \
TITULUS_API_USER=admin \
TITULUS_API_PASSWORD='***' \
./engine/collect-decklink-evidence.sh
```

## 10. Shutdown

Recommended:

```bash
./dev-stop.sh
```

Legacy stack scripts:

```bash
./start.sh
./stop.sh
```

## 11. Troubleshooting

- **`SQLITE_IOERR_SHORT_READ` in repo-local `data/`**  
  Use `TITULUS_DATA=/tmp/...` for dev/test and persistent `/var/lib/titulus` in deployment.

- **Protected API returns `401`**  
  Ensure valid bearer token from `/api/auth/login`.

- **Protected API returns `403`**  
  Current role lacks permission (admin-only endpoints like `/api/settings` and `/api/license`).

- **`run-engines.sh` cannot fetch channels**  
  Provide `TITULUS_API_TOKEN` or valid `TITULUS_API_USER/TITULUS_API_PASSWORD`.

- **Stream channel restarts immediately**  
  Validate `stream_url`, ffmpeg availability (`ffmpeg -version`), and receiver/firewall state.

- **`run-channel.sh: output_mode=stream requires --stream-url`**  
  Set `stream_url` in channel config or pass `--stream-url` explicitly.

- **DeckLink runtime unavailable on dev host**  
  Expected without card/driver. Use `browser`/`stream` until hardware host validation.

- **`EnableVideoOutput failed` on a DeckLink host that has the card**  
  Usually means another process already owns that `--device-index`'s output engine (e.g. a live channel from `run-engines.sh`), not a card/profile limitation. Check `pgrep -af "bg_engine --name=Channel"` before assuming a hardware limit — a 3-simultaneous-SDI-output limit hypothesis was investigated and retracted in `docs/phase11-baseline.md` §1 for exactly this reason.

- **DeckLink consumer crashes with `mutex lock failed` after a failed `Start()`**  
  Known issue (`docs/phase11-baseline.md` §5): reproduces when `EnableVideoOutput` fails (e.g. device already in use) and the abbreviated shutdown path runs. Does not affect any channel that started successfully. Tracked for a follow-up fix, not blocking.

- **Rundown slots from old DB look inconsistent**  
  Open/modify/save rundown once: backend applies soft normalization from legacy
  slot shape (`id/label/variables`) to canonical (`slotId/name/vars`).

