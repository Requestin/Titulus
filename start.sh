#!/usr/bin/env bash
# Titulus dev launcher (DEVELOPMENT_PROMPT §12.1).
#
# Starts the control plane for local development:
#   - backend  (Express + WS + SQLite)  -> http://localhost:3001
#   - frontend (Vite dev server)        -> http://localhost:3000
#
# The render plane (bg_engine) is launched separately via engine/run-engines.sh,
# once a channel is configured and the binary is built (Phase 0.3+).
#
# Usage: ./start.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

log() { printf '[start] %s\n' "$*"; }

# Backend ---------------------------------------------------------------------
if [[ ! -d backend/node_modules ]]; then
  log "installing backend deps..."
  (cd backend && npm install)
fi
log "starting backend on :3001 ..."
(cd backend && npm start) &
BACKEND_PID=$!

# Frontend --------------------------------------------------------------------
if [[ ! -d frontend/node_modules ]]; then
  log "installing frontend deps..."
  (cd frontend && npm install)
fi
log "starting frontend on :3000 ..."
(cd frontend && npm run dev) &
FRONTEND_PID=$!

cleanup() {
  log "stopping backend ($BACKEND_PID) and frontend ($FRONTEND_PID) ..."
  kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

log "Titulus control plane up: frontend http://localhost:3000  backend http://localhost:3001"
wait
