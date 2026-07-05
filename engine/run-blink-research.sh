#!/usr/bin/env bash
# engine/run-blink-research.sh — Phase 12 Blink pipeline research orchestrator.
#
# Temporarily restarts Channel 2 with --remote-debugging-port, collects:
#   1) 15s Chrome trace (blink+cc)
#   2) DOM node counts + styleWrites/skippedWrites (static vs animated)
#   3) Trace parse (Layout/Paint/Raster per frame + JS symbols)
#
# Results → docs/development-phases/phase-12-blink-pipeline.md

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_BIN="${ENGINE_BIN:-${ROOT}/engine/build/Release/bg_engine}"
BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:3002}"
CACHE_ROOT="${CACHE_ROOT:-/tmp/titulus-engines}"
OUT_DIR="${OUT_DIR:-/tmp/titulus-blink-research}"
CDP_PORT="${CDP_PORT:-9222}"
TRACE_SEC="${TRACE_SEC:-15}"

CH2_ID="8e78d06a-c0a5-43fd-ab1b-d1c35e6bd8e5"
CH1_ID="6fbc1394-889d-4373-a12c-d1d36bf40d57"
CH3_ID="95a844f9-5f1e-4f4d-baf0-12cd4f9502fe"

mkdir -p "$OUT_DIR"

log() { echo "[blink-research] $*"; }

# --- Auth + template fetch ---------------------------------------------------
TOKEN=""
fetch_token() {
  TOKEN=$(curl -sf -X POST "${BACKEND_URL}/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d '{"username":"admin","password":"admin123"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
}

fetch_template() {
  local id="$1"
  curl -sf "${BACKEND_URL}/api/templates/${id}" \
    -H "Authorization: Bearer ${TOKEN}" > "${OUT_DIR}/template-${id}.json"
}

# --- Channel 2 supervisor (decklink + debug port) ----------------------------
stop_ch2_supervisor() {
  local pid
  pid=$(pgrep -f "run-channel.sh --id=${CH2_ID}" | head -1 || true)
  if [[ -n "$pid" ]]; then
    log "Stopping Ch2 supervisor pid=$pid"
    kill "$pid" 2>/dev/null || true
    sleep 1
  fi
  pkill -f "cache-${CH2_ID}" 2>/dev/null || true
  sleep 2
}

start_ch2_debug() {
  log "Starting Ch2 with remote-debugging-port=${CDP_PORT}"
  REMOTE_DEBUGGING_PORT="$CDP_PORT" \
  BACKEND_URL="$BACKEND_URL" \
  ENGINE_BIN="$ENGINE_BIN" \
  CACHE_ROOT="$CACHE_ROOT" \
  bash "${ROOT}/engine/run-channel.sh" \
    --id="$CH2_ID" \
    --name="Channel 2" \
    --output-mode=decklink \
    --device-index=2 \
    --display-mode=HD1080i50 \
    --keyer=fill_only \
    --cores=2,8,3,9 \
    > "${OUT_DIR}/ch2-supervisor.log" 2>&1 &
  echo $! > "${OUT_DIR}/ch2-supervisor.pid"
}

wait_cdp() {
  local i
  for i in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then
      log "CDP ready on :${CDP_PORT} (${i}s)"
      return 0
    fi
    sleep 1
  done
  echo "CDP port ${CDP_PORT} not ready after 60s" >&2
  tail -30 "${OUT_DIR}/ch2-supervisor.log" >&2 || true
  return 1
}

restore_ch2_normal() {
  log "Restoring Ch2 without debug port"
  if [[ -f "${OUT_DIR}/ch2-supervisor.pid" ]]; then
    kill "$(cat "${OUT_DIR}/ch2-supervisor.pid")" 2>/dev/null || true
  fi
  pkill -f "cache-${CH2_ID}" 2>/dev/null || true
  sleep 2
  BACKEND_URL="$BACKEND_URL" \
  ENGINE_BIN="$ENGINE_BIN" \
  CACHE_ROOT="$CACHE_ROOT" \
  bash "${ROOT}/engine/run-channel.sh" \
    --id="$CH2_ID" \
    --name="Channel 2" \
    --output-mode=decklink \
    --device-index=2 \
    --display-mode=HD1080i50 \
    --keyer=fill_only \
    --cores=2,8,3,9 \
    >> "${OUT_DIR}/ch2-restore.log" 2>&1 &
}

dom_count_via_cdp() {
  local port="$1" label="$2"
  node "${ROOT}/engine/research/collect-dom-count.mjs" \
    --port="$port" --label="$label" >> "${OUT_DIR}/dom-counts.jsonl" 2>&1 || true
}

# --- Main ---------------------------------------------------------------------
main() {
  log "Output dir: $OUT_DIR"
  fetch_token

  # On-air template (same on all 3 channels currently)
  TPL_ID=$(curl -sf "${BACKEND_URL}/api/onair" -H "Authorization: Bearer ${TOKEN}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['${CH2_ID}'][0])")
  fetch_template "$TPL_ID"
  log "Template: $TPL_ID"

  stop_ch2_supervisor
  start_ch2_debug
  wait_cdp

  TRACE_FILE="${OUT_DIR}/trace-ch2-${TRACE_SEC}s.json"
  REPORT_FILE="${OUT_DIR}/trace-report.json"
  METRICS_FILE="${OUT_DIR}/live-metrics.json"
  CACHE_CH2="${CACHE_ROOT}/cache-${CH2_ID}"

  log "Collecting ${TRACE_SEC}s trace + JS profile…"
  node "${ROOT}/engine/research/collect-cdp-trace.mjs" \
    --port="$CDP_PORT" --duration="$TRACE_SEC" \
    --cache-dir="$CACHE_CH2" \
    --out="$TRACE_FILE"

  log "Parsing trace (Layout/Paint/Raster + JS)…"
  node "${ROOT}/engine/research/parse-chrome-trace.mjs" \
    --in="$TRACE_FILE" --out="$REPORT_FILE" | tee "${OUT_DIR}/trace-report.txt"

  log "Collecting live DOM + HUD stats sweep…"
  node "${ROOT}/engine/research/collect-live-metrics.mjs" \
    --port="$CDP_PORT" \
    --template="${OUT_DIR}/template-${TPL_ID}.json" \
    --out="$METRICS_FILE"

  # DOM counts for Ch1/Ch3 via quick null-engine with same URL (no decklink disruption)
  log "DOM counts Ch1/Ch3 via ephemeral null engines (same on-air URL)…"
  : > "${OUT_DIR}/dom-counts.jsonl"
  dom_count_via_cdp "$CDP_PORT" "ch2-live"

  for CH_ID in "$CH1_ID" "$CH3_ID"; do
    local_port=$((CDP_PORT + 1))
    [[ "$CH_ID" == "$CH1_ID" ]] && local_port=9223
    [[ "$CH_ID" == "$CH3_ID" ]] && local_port=9224
    log "Ephemeral null engine for ${CH_ID} on port ${local_port}"
    "${ENGINE_BIN}" \
      --name="dom-probe-${CH_ID}" \
      --url="${BACKEND_URL}/channel.html?channel=${CH_ID}&engine=1&engine_fps=50&w=1920&h=1080" \
      --width=1920 --height=1080 --fps=50 --duration=0 \
      --consumer=null \
      --cache-dir="${OUT_DIR}/cache-probe-${CH_ID}" \
      --remote-debugging-port="${local_port}" \
      > "${OUT_DIR}/probe-${CH_ID}.log" 2>&1 &
    probe_pid=$!
    sleep 5
    if curl -sf "http://127.0.0.1:${local_port}/json/version" >/dev/null 2>&1; then
      node "${ROOT}/engine/research/collect-dom-count.mjs" \
        --port="$local_port" --label="$CH_ID" >> "${OUT_DIR}/dom-counts.jsonl"
    fi
    kill "$probe_pid" 2>/dev/null || true
    pkill -f "cache-probe-${CH_ID}" 2>/dev/null || true
    sleep 1
  done

  restore_ch2_normal

  log "Generating docs/development-phases/phase-12-blink-pipeline.md"
  node "${ROOT}/engine/research/write-results-doc.mjs" \
    --out-dir="$OUT_DIR" \
    --template-id="$TPL_ID" \
    --doc="${ROOT}/docs/development-phases/phase-12-blink-pipeline.md"

  log "Done. Artifacts in ${OUT_DIR}"
}

main "$@"
