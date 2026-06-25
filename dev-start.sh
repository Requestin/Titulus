#!/usr/bin/env bash
# Titulus dev stack launcher — frontend :3011, backend :3002, render engines.
#
# Matches nginx ops/nginx/graphics.gyhyry.com.conf (public UI on :3011).
# Usage: ./dev-start.sh
#
# Stop: ./dev-stop.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

FE_PORT="${TITULUS_FE_PORT:-3011}"
BE_PORT="${TITULUS_BE_PORT:-3002}"
HOST="${TITULUS_HOST:-127.0.0.1}"
DATA_DIR="${TITULUS_DATA:-/tmp/titulus-dev}"
LOG_DIR="$ROOT/logs"
PID_DIR="$LOG_DIR/dev"

log() { printf '[dev-start] %s\n' "$*"; }

mkdir -p "$PID_DIR" "$DATA_DIR/uploads"

port_busy() {
  ss -ltn 2>/dev/null | awk -v p=":$1" '$4 ~ p {exit 0} END {exit 1}'
}

if port_busy "$FE_PORT"; then
  log "ERROR: port $FE_PORT already in use (frontend). Run ./dev-stop.sh first."
  exit 1
fi
if port_busy "$BE_PORT"; then
  log "ERROR: port $BE_PORT already in use (backend). Run ./dev-stop.sh first."
  exit 1
fi

# Dependencies ----------------------------------------------------------------
if [[ ! -d backend/node_modules ]]; then
  log "installing backend deps..."
  (cd backend && npm install)
fi
if [[ ! -d frontend/node_modules ]]; then
  log "installing frontend deps..."
  (cd frontend && npm install)
fi
if [[ ! -d runtime/node_modules ]]; then
  log "installing runtime deps..."
  (cd runtime && npm install)
fi

# Runtime bundle (channel.html / Program Monitor) -----------------------------
if [[ ! -f backend/public/bg-runtime.js ]]; then
  log "building @titulus/runtime -> backend/public/bg-runtime.js ..."
  (cd runtime && npm run build)
fi

# Backend ---------------------------------------------------------------------
log "starting backend on ${HOST}:${BE_PORT} (data: ${DATA_DIR}) ..."
cd "$ROOT/backend"
PORT="$BE_PORT" HOST="$HOST" TITULUS_DATA="$DATA_DIR" \
  node src/index.js > "$LOG_DIR/backend.log" 2>&1 &
echo $! > "$PID_DIR/backend.pid"
cd "$ROOT"

for i in $(seq 1 30); do
  if curl -sf "http://${HOST}:${BE_PORT}/api/health" >/dev/null 2>&1; then
    break
  fi
  if [[ "$i" -eq 30 ]]; then
    log "ERROR: backend did not become healthy — see $LOG_DIR/backend.log"
    exit 1
  fi
  sleep 0.2
done

# Frontend --------------------------------------------------------------------
log "starting frontend on ${HOST}:${FE_PORT} (proxy -> backend :${BE_PORT}) ..."
cd "$ROOT/frontend"
VITE_BACKEND="http://${HOST}:${BE_PORT}" \
  npm run dev -- --port "$FE_PORT" --host "$HOST" --strictPort > "$LOG_DIR/frontend.log" 2>&1 &
echo $! > "$PID_DIR/frontend.pid"
cd "$ROOT"

for i in $(seq 1 40); do
  if curl -sf "http://${HOST}:${FE_PORT}/" >/dev/null 2>&1 \
    && ! curl -sI "http://${HOST}:${FE_PORT}/" 2>/dev/null | grep -qi 'x-powered-by: express'; then
    break
  fi
  if [[ "$i" -eq 40 ]]; then
    log "ERROR: frontend did not start on :${FE_PORT} — see $LOG_DIR/frontend.log"
    log "       (is another process bound to :${FE_PORT}? run ./dev-stop.sh)"
    exit 1
  fi
  sleep 0.25
done

# Render engines (optional — needs bg_engine binary + channels in Settings) ----
ENGINE_BIN="${ENGINE_BIN:-$ROOT/engine/build/Release/bg_engine}"
if [[ -x "$ENGINE_BIN" ]]; then
  log "starting run-engines.sh (BACKEND_URL=http://${HOST}:${BE_PORT}) ..."
  BACKEND_URL="http://${HOST}:${BE_PORT}" ENGINE_BIN="$ENGINE_BIN" \
    "$ROOT/engine/run-engines.sh" > "$LOG_DIR/engines.log" 2>&1 &
  echo $! > "$PID_DIR/engines.pid"
else
  log "skip run-engines: bg_engine not found at $ENGINE_BIN (build engine/ first)"
fi

log ""
log "Titulus dev stack up:"
log "  frontend  http://${HOST}:${FE_PORT}   (nginx graphics.gyhyry.com -> here)"
log "  backend   http://${HOST}:${BE_PORT}"
log "  logs      $LOG_DIR/"
log "  stop      ./dev-stop.sh"
