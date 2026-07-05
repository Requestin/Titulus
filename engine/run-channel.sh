#!/usr/bin/env bash
# engine/run-channel.sh — launch one bg_engine for a Titulus channel (DEVELOPMENT_PROMPT §9.8).
#
# Called by run-engines.sh with channel JSON on stdin or via env vars.
# Supervisor loop: exit 42 (DeckLink profile switch) -> 6s delay; other exit -> 3s.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_BIN="${ENGINE_BIN:-${ROOT}/engine/build/Release/bg_engine}"
BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:3001}"
CACHE_ROOT="${CACHE_ROOT:-/tmp/titulus-engines}"
CORES="${CORES:-}"          # e.g. "0-1" for taskset
DRY_RUN="${DRY_RUN:-0}"

usage() {
  cat <<'EOF'
Usage: run-channel.sh [options] --id=CHANNEL_ID --name=NAME --output-mode=MODE [more flags]

Required:
  --id=ID              Channel UUID
  --name=NAME          Log label
  --output-mode=MODE   browser|obs_vmix|decklink|stream

Optional:
  --device-index=N     DeckLink device (default -1)
  --display-mode=NAME  DeckLink format (default HD1080i50)
  --keyer=MODE         external|internal|fill_only (default external)
  --stream-url=URL     For stream output
  --cores=RANGE        taskset core range (e.g. 0-1)
  --dry-run            Print command, do not run
  --help

Environment: ENGINE_BIN, BACKEND_URL, CACHE_ROOT, DRY_RUN
EOF
}

# Defaults
CH_ID=""
CH_NAME=""
OUTPUT_MODE="browser"
DEVICE_INDEX=-1
DISPLAY_MODE="HD1080i50"
KEYER="external"
STREAM_URL=""
REMOTE_DEBUGGING_PORT="${REMOTE_DEBUGGING_PORT:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --id=*)           CH_ID="${1#*=}" ;;
    --name=*)         CH_NAME="${1#*=}" ;;
    --output-mode=*)  OUTPUT_MODE="${1#*=}" ;;
    --device-index=*) DEVICE_INDEX="${1#*=}" ;;
    --display-mode=*) DISPLAY_MODE="${1#*=}" ;;
    --keyer=*)        KEYER="${1#*=}" ;;
    --stream-url=*)   STREAM_URL="${1#*=}" ;;
    --cores=*)        CORES="${1#*=}" ;;
    --remote-debugging-port=*) REMOTE_DEBUGGING_PORT="${1#*=}" ;;
    --dry-run)        DRY_RUN=1 ;;
    -h|--help)        usage; exit 0 ;;
    *) echo "run-channel.sh: unknown option $1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

if [[ -z "$CH_ID" || -z "$CH_NAME" ]]; then
  echo "run-channel.sh: --id and --name required" >&2
  exit 1
fi

if [[ ! -x "$ENGINE_BIN" && "$DRY_RUN" != "1" ]]; then
  echo "run-channel.sh: bg_engine not found at $ENGINE_BIN" >&2
  echo "  build: cd engine && cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j" >&2
  exit 1
fi

# Map output_mode -> consumer (§9.8).
CONSUMER="null"
EXTRA_ARGS=()
case "$OUTPUT_MODE" in
  browser|obs_vmix)
    CONSUMER="null"
    ;;
  decklink)
    CONSUMER="decklink"
    EXTRA_ARGS+=(--device-index="$DEVICE_INDEX" --display-mode="$DISPLAY_MODE" --keyer="$KEYER")
    ;;
  stream)
    CONSUMER="stream"
    if [[ -z "$STREAM_URL" ]]; then
      echo "run-channel.sh: output_mode=stream requires --stream-url" >&2
      exit 1
    fi
    EXTRA_ARGS+=(--stream-url="$STREAM_URL")
    ;;
  *)
    echo "run-channel.sh: unknown output_mode=$OUTPUT_MODE" >&2
    exit 1
    ;;
esac

# Parse backend host:port for channel.html URL.
if [[ "$BACKEND_URL" =~ ^https?://([^/]+) ]]; then
  BACKEND_HOST="${BASH_REMATCH[1]}"
else
  BACKEND_HOST="127.0.0.1:3001"
fi

PAGE_URL="http://${BACKEND_HOST}/channel.html?channel=${CH_ID}&engine=1&engine_fps=50&w=1920&h=1080"
CACHE_DIR="${CACHE_ROOT}/cache-${CH_ID}"
mkdir -p "$CACHE_DIR"

run_once() {
  local -a cmd=()
  if [[ -n "$CORES" ]]; then
    cmd=(taskset -c "$CORES")
  fi
  cmd+=("$ENGINE_BIN"
    --name="$CH_NAME"
    --url="$PAGE_URL"
    --width=1920 --height=1080 --fps=50
    --duration=0
    --consumer="$CONSUMER"
    --cache-dir="$CACHE_DIR"
    "${EXTRA_ARGS[@]}"
  )
  if [[ -n "$REMOTE_DEBUGGING_PORT" ]]; then
    cmd+=(--remote-debugging-port="$REMOTE_DEBUGGING_PORT")
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] '; printf '%q ' "${cmd[@]}"; echo
    return 0
  fi
  "${cmd[@]}"
}

if [[ "$DRY_RUN" == "1" ]]; then
  run_once
  exit 0
fi

echo "[run-channel] ${CH_NAME} (${CH_ID}) mode=${OUTPUT_MODE} consumer=${CONSUMER} cores=${CORES:-all} cache=${CACHE_DIR}"

while true; do
  set +e
  run_once
  code=$?
  set -e
  if [[ "$code" -eq 42 ]]; then
    echo "[run-channel] ${CH_NAME}: exit 42 (profile switch) — restart in 6s" >&2
    sleep 6
  else
    echo "[run-channel] ${CH_NAME}: exited ${code} — restart in 3s" >&2
    sleep 3
  fi
done
