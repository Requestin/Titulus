#!/usr/bin/env bash
# Titulus dev stack stopper — kills frontend :3011, backend :3002, run-engines.
#
# Usage: ./dev-stop.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FE_PORT="${TITULUS_FE_PORT:-3011}"
BE_PORT="${TITULUS_BE_PORT:-3002}"
PID_DIR="$ROOT/logs/dev"

log() { printf '[dev-stop] %s\n' "$*"; }

kill_pid_file() {
  local label="$1" file="$2"
  if [[ -f "$file" ]]; then
    local pid
    pid="$(cat "$file" 2>/dev/null || true)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      log "killing $label pid $pid"
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$file"
  fi
}

# PID files from dev-start ----------------------------------------------------
kill_pid_file "engines"  "$PID_DIR/engines.pid"
kill_pid_file "frontend" "$PID_DIR/frontend.pid"
kill_pid_file "backend"  "$PID_DIR/backend.pid"

# run-channel supervisors (children of run-engines) ---------------------------
if pgrep -f "$ROOT/engine/run-channel.sh" >/dev/null 2>&1; then
  log "killing run-channel.sh supervisors ..."
  pkill -f "$ROOT/engine/run-channel.sh" 2>/dev/null || true
fi

# Fallback: listeners on dev ports (do NOT use pkill -f PORT=...) -------------
for port in "$FE_PORT" "$BE_PORT"; do
  pids="$(ss -ltnp 2>/dev/null | awk -v p=":$port" '$4 ~ p {print $7}' | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | sort -u)"
  for pid in $pids; do
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      log "killing pid $pid (port $port)"
      kill "$pid" 2>/dev/null || true
    fi
  done
done

# Stray bg_engine from this dev cache root ------------------------------------
if pgrep -f "/tmp/titulus-engines/" >/dev/null 2>&1; then
  log "killing bg_engine (titulus-engines cache) ..."
  pkill -f "/tmp/titulus-engines/" 2>/dev/null || true
fi

log "done"
