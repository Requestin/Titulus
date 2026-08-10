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
BIND_HOST="${TITULUS_HOST:-0.0.0.0}"
CONNECT_HOST="${TITULUS_CONNECT_HOST:-127.0.0.1}"
DATA_DIR="${TITULUS_DATA:-/tmp/titulus-dev}"
LOG_DIR="$ROOT/logs"
PID_DIR="$LOG_DIR/dev"

log() { printf '[dev-start] %s\n' "$*"; }

DEFAULT_ENGINE_BIN="$ROOT/engine/build/Release/bg_engine"
ENGINE_BIN="${ENGINE_BIN:-$DEFAULT_ENGINE_BIN}"
DEV_PACING_MODE="${TITULUS_DEV_PACING_MODE:-one_tick}"

case "$DEV_PACING_MODE" in
  accumulator|one_tick) ;;
  *)
    log "ERROR: TITULUS_DEV_PACING_MODE must be accumulator or one_tick"
    exit 1
    ;;
esac

mkdir -p "$PID_DIR" "$DATA_DIR/uploads"

port_busy() {
  ss -ltn 2>/dev/null | awk -v port="$1" '
    $4 ~ (":" port "$") { found = 1 }
    END { exit found ? 0 : 1 }
  '
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

# bg_engine (cmake + CEF) — build if missing ----------------------------------
ensure_engine() {
  if [[ -x "$ENGINE_BIN" ]]; then
    return 0
  fi
  if [[ "$ENGINE_BIN" != "$DEFAULT_ENGINE_BIN" ]]; then
    log "WARN: ENGINE_BIN=$ENGINE_BIN not found/executable — skip auto-build"
    return 1
  fi

  local engine_dir="$ROOT/engine"
  local fetch_script="$engine_dir/third_party/fetch-cef.sh"

  log "bg_engine not found — building (Release) ..."

  if ! ls -d "$engine_dir"/third_party/cef/cef_binary_*_linux64_minimal >/dev/null 2>&1; then
    log "fetching CEF (first build; may take a few minutes) ..."
    if [[ ! -x "$fetch_script" ]]; then
      chmod +x "$fetch_script"
    fi
    "$fetch_script"
  fi

  if ! command -v cmake >/dev/null 2>&1; then
    log "ERROR: cmake not found — install cmake (>= 3.21) to build bg_engine"
    return 1
  fi

  cmake -S "$engine_dir" -B "$engine_dir/build" -DCMAKE_BUILD_TYPE=Release
  cmake --build "$engine_dir/build" -j"$(nproc)"

  if [[ ! -x "$ENGINE_BIN" ]]; then
    log "ERROR: build finished but $ENGINE_BIN is missing"
    return 1
  fi
  log "bg_engine built: $ENGINE_BIN"
}

ensure_engine || true

# Backend ---------------------------------------------------------------------
# Phase 11.4: nice +10 so the control plane yields CPU to pinned bg_engine
# channel threads under contention. On a channel host, 3ch x 2 physical
# cores already claims every physical core (docs/phase11-baseline.md §3) —
# there is no spare core to isolate the backend onto, so this is a scheduling
# *priority* nudge, not a cpuset change: the backend still runs on the same
# cores, it just loses tie-breaks to the render/pump threads that share them.
# `nice` is best-effort (may be a no-op in some container/CI setups); falls
# through to unprioritized `node` if unavailable.
log "starting backend on ${BIND_HOST}:${BE_PORT} (data: ${DATA_DIR}) ..."
cd "$ROOT/backend"
NICE_CMD=()
if command -v nice >/dev/null 2>&1; then NICE_CMD=(nice -n 10); fi
PORT="$BE_PORT" HOST="$BIND_HOST" TITULUS_DATA="$DATA_DIR" \
  "${NICE_CMD[@]}" node src/index.js > "$LOG_DIR/backend.log" 2>&1 &
echo $! > "$PID_DIR/backend.pid"
cd "$ROOT"

for i in $(seq 1 30); do
  if curl -sf "http://${CONNECT_HOST}:${BE_PORT}/api/health" >/dev/null 2>&1; then
    break
  fi
  if [[ "$i" -eq 30 ]]; then
    log "ERROR: backend did not become healthy — see $LOG_DIR/backend.log"
    exit 1
  fi
  sleep 0.2
done

# Frontend --------------------------------------------------------------------
# Phase 11.4: same nice-priority rationale as the backend above.
log "starting frontend on ${BIND_HOST}:${FE_PORT} (proxy -> backend ${CONNECT_HOST}:${BE_PORT}) ..."
cd "$ROOT/frontend"
VITE_BACKEND="http://${CONNECT_HOST}:${BE_PORT}" \
  "${NICE_CMD[@]}" npm run dev -- --port "$FE_PORT" --host "$BIND_HOST" --strictPort > "$LOG_DIR/frontend.log" 2>&1 &
echo $! > "$PID_DIR/frontend.pid"
cd "$ROOT"

for i in $(seq 1 40); do
  if curl -sf "http://${CONNECT_HOST}:${FE_PORT}/" >/dev/null 2>&1 \
    && ! curl -sI "http://${CONNECT_HOST}:${FE_PORT}/" 2>/dev/null | grep -qi 'x-powered-by: express'; then
    break
  fi
  if [[ "$i" -eq 40 ]]; then
    log "ERROR: frontend did not start on :${FE_PORT} — see $LOG_DIR/frontend.log"
    log "       (is another process bound to :${FE_PORT}? run ./dev-stop.sh)"
    exit 1
  fi
  sleep 0.25
done

# Render engines (needs bg_engine binary + channels in Settings) ------------
if [[ -x "$ENGINE_BIN" ]]; then
  log "starting run-engines.sh (BACKEND_URL=http://${CONNECT_HOST}:${BE_PORT}, DeckLink pacing=${DEV_PACING_MODE}) ..."
  setsid env BACKEND_URL="http://${CONNECT_HOST}:${BE_PORT}" ENGINE_BIN="$ENGINE_BIN" \
    TITULUS_PACING_MODE="$DEV_PACING_MODE" \
    "$ROOT/engine/run-engines.sh" > "$LOG_DIR/engines.log" 2>&1 &
  echo $! > "$PID_DIR/engines.pid"
else
  log "skip run-engines: bg_engine not available at $ENGINE_BIN"
fi

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
log ""
log "Titulus dev stack up:"
log "  frontend  http://${CONNECT_HOST}:${FE_PORT}"
if [[ -n "${LAN_IP:-}" ]]; then
  log "  LAN URL   http://${LAN_IP}:${FE_PORT}"
fi
log "  backend   http://${CONNECT_HOST}:${BE_PORT} (bound on ${BIND_HOST})"
log "  logs      $LOG_DIR/"
log "  stop      ./dev-stop.sh"
