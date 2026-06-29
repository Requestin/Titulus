# Titulus Runbook (Ubuntu 24.04+)

This runbook describes a fresh setup and operational flow for Titulus control plane + render plane.

## 1. Prerequisites

Install base tooling:

```bash
sudo apt-get update
sudo apt-get install -y \
  git curl jq ffmpeg python3 build-essential cmake pkg-config \
  libx11-dev libxcomposite-dev libxdamage-dev libxrandr-dev libxext-dev \
  libglib2.0-dev libnss3-dev libatk1.0-dev libatk-bridge2.0-dev libcups2-dev \
  libxkbcommon-dev libdrm-dev
```

Install Node.js 20+ (example with nvm):

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.nvm/nvm.sh
nvm install 20
nvm use 20
```

## 2. Clone and Bootstrap

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

Build runtime bundle (`backend/public/bg-runtime.js`):

```bash
cd runtime && npm run build
cd ..
```

## 3. Build `bg_engine`

Download CEF runtime:

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

Optional DeckLink compile enablement (if SDK headers are present):

```bash
cd engine
cmake -S . -B build \
  -DCMAKE_BUILD_TYPE=Release \
  -DBG_ENABLE_DECKLINK=ON \
  -DDECKLINK_SDK_INCLUDE="/path/to/Blackmagic DeckLink SDK/Linux/include"
cmake --build build -j"$(nproc)"
cd ..
```

## 4. Start Control Plane (Dev)

Recommended startup (explicit data dir, avoids overlay-fs SQLite issues):

```bash
cd /root/Titulus/backend
PORT=3001 TITULUS_DATA=/tmp/titulus-data node src/index.js
```

In another terminal:

```bash
cd /root/Titulus/frontend
npm run dev
```

Open:

- frontend: `http://127.0.0.1:3000`
- backend health: `http://127.0.0.1:3001/api/health`

Alternative convenience script:

```bash
./start.sh
```

## 5. Configure Channels

Create/update channels in UI (`/settings`) or via REST.

Example channel create (stream mode):

```bash
curl -s -X POST http://127.0.0.1:3001/api/channels \
  -H 'content-type: application/json' \
  -d '{
    "name":"Ch1",
    "output_mode":"stream",
    "device_index":-1,
    "display_mode":"HD1080i50",
    "keyer_mode":"external",
    "stream_url":"srt://127.0.0.1:9999?mode=caller"
  }'
```

Validate channel list:

```bash
curl -s http://127.0.0.1:3001/api/channels | jq
```

## 6. Start Render Plane

Dry-run channel launch plan:

```bash
BACKEND_URL=http://127.0.0.1:3001 ./engine/run-engines.sh --dry-run
```

Start all configured channels:

```bash
BACKEND_URL=http://127.0.0.1:3001 ./engine/run-engines.sh
```

Single channel run (manual):

```bash
./engine/run-channel.sh \
  --id=<channel-id> \
  --name="Channel 1" \
  --output-mode=stream \
  --stream-url="srt://127.0.0.1:9999?mode=caller"
```

## 7. Operational Smoke Checks

### 7.1 Template validation

```bash
curl -s -X POST http://127.0.0.1:3001/api/templates/validate \
  -H 'content-type: application/json' \
  -d '{"id":"t","name":"T","canvas":{"width":1920,"height":1080,"background":"transparent"},"variables":[],"groups":[],"layers":[],"rootStack":[],"groupStacks":{},"timeline":{"fps":50,"durationFrames":1,"playbackMode":"bounded","directors":[{"id":"d","name":"D","durationFrames":1,"offsetFrames":0,"autostart":true,"loop":false,"swing":false}],"trackDirectors":{},"keyframes":[],"actions":[]}}'
```

Expected: `{"valid":true,...}`.

### 7.2 Stream output check (local SRT receiver)

Receiver:

```bash
ffplay "srt://127.0.0.1:9999?mode=listener"
```

Engine sender: channel configured with matching `stream_url`.

### 7.3 Upload pipeline check

```bash
curl -s -X POST http://127.0.0.1:3001/api/uploads \
  -F 'file=@/path/to/video.mp4;type=video/mp4'
```

Poll job:

```bash
curl -s http://127.0.0.1:3001/api/uploads/jobs/<job-id> | jq
```

## 8. Shutdown

If started manually, stop processes by PID or port.

Example by ports:

```bash
for port in 3000 3001; do
  for p in $(ss -ltnp | grep ":$port" | sed -n 's/.*pid=\([0-9]\+\).*/\1/p'); do
    kill "$p"
  done
done
```

Convenience:

```bash
./stop.sh
```

## 9. Troubleshooting

- **`SQLITE_IOERR_SHORT_READ` in repo-local `data/`**  
  Use `TITULUS_DATA=/tmp/...` for dev/test, persistent path like `/var/lib/titulus` in deployment.

- **Stream channel restarts immediately**  
  Check `stream_url`, ffmpeg presence (`ffmpeg -version`), and firewall/receiver availability.

- **`run-channel.sh: output_mode=stream requires --stream-url`**  
  Set `stream_url` in channel settings or pass `--stream-url` directly.

- **DeckLink runtime unavailable**  
  Expected on hosts without card/driver. Use `browser` or `stream` mode until hardware validation host is available.  
  For final SDI acceptance procedure and evidence pack use `docs/phase6-decklink-validation-closure.md` and run `engine/collect-decklink-evidence.sh` on the HW host.

