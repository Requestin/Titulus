#!/usr/bin/env bash
# Titulus dev stopper (DEVELOPMENT_PROMPT §12.1).
#
# Stops control-plane processes started by start.sh. The render plane
# (bg_engine) is managed by engine/stop-engines.sh / run-engines.sh.
#
# Usage: ./stop.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '[stop] %s\n' "$*"; }

# Match the dev ports used by start.sh to find the listening processes.
found=0
for port in 3000 3001; do
  pids="$( (command -v ss >/dev/null 2>&1 && ss -ltnp 2>/dev/null | awk -v p=":$port" '$4 ~ p {print $7}' | sed 's/.*pid=\([0-9]*\).*/\1/') || true )"
  for pid in $pids; do
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      log "killing pid $pid (port $port)"
      kill "$pid" 2>/dev/null || true
      found=1
    fi
  done
done

if [[ $found -eq 0 ]]; then
  log "no control-plane processes found on ports 3000/3001"
fi
