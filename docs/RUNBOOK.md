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

Health check:

```bash
curl -s http://127.0.0.1:3002/api/health
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

## 9. DeckLink hardware validation handoff

For final SDI acceptance (Phase 6.4), use:

- `docs/phase6-decklink-validation-closure.md`
- `engine/collect-decklink-evidence.sh`

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

