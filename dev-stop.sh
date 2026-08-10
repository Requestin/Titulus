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

engine_processes_alive() {
  pgrep -f "$ROOT/engine/run-channel.sh" >/dev/null 2>&1 \
    || pgrep -f "/tmp/titulus-engines/" >/dev/null 2>&1
}

wait_for_engine_shutdown() {
  local attempt
  for attempt in $(seq 1 40); do
    if ! engine_processes_alive; then
      return 0
    fi
    sleep 0.25
  done

  log "engines did not exit after TERM; forcing remaining dev cache processes"
  pkill -KILL -f "$ROOT/engine/run-channel.sh" 2>/dev/null || true
  pkill -KILL -f "/tmp/titulus-engines/" 2>/dev/null || true
  for attempt in $(seq 1 20); do
    if ! engine_processes_alive; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

kill_engine_group() {
  local file="$PID_DIR/engines.pid"
  [[ -f "$file" ]] || return 0

  local pid pgid
  pid="$(<"$file" 2>/dev/null || true)"
  rm -f "$file"
  [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null || return 0

  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
  if [[ "$pgid" == "$pid" ]]; then
    log "killing engines process group $pid"
    kill -TERM -- "-$pid" 2>/dev/null || true
  else
    # Compatibility with stacks launched before `dev-start` used `setsid`.
    log "killing engines pid $pid"
    kill "$pid" 2>/dev/null || true
  fi
}

# Engines run in their own session from dev-start. Terminate that entire
# process group and wait before any new engine can reuse its CEF cache path.
kill_engine_group

# Compatibility cleanup for stacks started by older dev-start versions.
if pgrep -f "$ROOT/engine/run-channel.sh" >/dev/null 2>&1; then
  log "killing legacy run-channel.sh supervisors ..."
  pkill -f "$ROOT/engine/run-channel.sh" 2>/dev/null || true
fi
if pgrep -f "/tmp/titulus-engines/" >/dev/null 2>&1; then
  log "killing remaining bg_engine/CEF dev-cache processes ..."
  pkill -f "/tmp/titulus-engines/" 2>/dev/null || true
fi
if ! wait_for_engine_shutdown; then
  log "ERROR: a dev engine process survived shutdown"
  exit 1
fi

# PID files from dev-start ----------------------------------------------------
kill_pid_file "frontend" "$PID_DIR/frontend.pid"
kill_pid_file "backend"  "$PID_DIR/backend.pid"

# Stray vite from a prior run (may have fallen back to 3012 if 3011 was busy)
if pgrep -f "$ROOT/frontend/node_modules/.bin/vite" >/dev/null 2>&1; then
  log "killing vite dev server ..."
  pkill -f "$ROOT/frontend/node_modules/.bin/vite" 2>/dev/null || true
fi

# Fallback: listeners on dev ports (do NOT use pkill -f PORT=...) -------------
for port in "$FE_PORT" "$BE_PORT" 3012; do
  pids="$(ss -ltnp 2>/dev/null | awk -v p=":$port" '$4 ~ p {print $7}' | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | sort -u)"
  for pid in $pids; do
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      log "killing pid $pid (port $port)"
      kill "$pid" 2>/dev/null || true
    fi
  done
done

log "done"
