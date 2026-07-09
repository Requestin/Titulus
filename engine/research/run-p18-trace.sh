#!/usr/bin/env bash
# engine/research/run-p18-trace.sh — capture a Chrome startup trace for Phase 18 P0.3.
#
# Uses BG_TRACE_SECONDS + BG_TRACE_CATEGORIES (engine_app.cpp) so the browser
# process writes a JSON trace into the cache dir. Then copies it to --out and
# optionally runs parse-chrome-trace.mjs.
#
# Usage:
#   ./engine/research/run-p18-trace.sh --channel=CH --out=engine/research/results/p18/p03-trace.json \
#     [--duration=20] [--cores=0,6,1,7] [--backend=http://127.0.0.1:3003] \
#     [--bin=engine/build-p18/Release/bg_engine] [--categories=cc,ipc,benchmark,toplevel,sequence_manager] \
#     [--num-raster-threads=3] [--parse]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

CHANNEL=""
OUT=""
DURATION=20
CORES=""
BACKEND="http://127.0.0.1:3003"
BIN="${ROOT}/engine/build-p18/Release/bg_engine"
CATEGORIES="cc,ipc,benchmark,toplevel,sequence_manager,blink,disabled-by-default-devtools.timeline"
NUM_RASTER_THREADS="3"
DO_PARSE=0

for arg in "$@"; do
  case "$arg" in
    --channel=*) CHANNEL="${arg#*=}" ;;
    --out=*) OUT="${arg#*=}" ;;
    --duration=*) DURATION="${arg#*=}" ;;
    --cores=*) CORES="${arg#*=}" ;;
    --backend=*) BACKEND="${arg#*=}" ;;
    --bin=*) BIN="${arg#*=}" ;;
    --categories=*) CATEGORIES="${arg#*=}" ;;
    --num-raster-threads=*) NUM_RASTER_THREADS="${arg#*=}" ;;
    --parse) DO_PARSE=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 1 ;;
  esac
done

[[ -n "$CHANNEL" && -n "$OUT" ]] || { echo "need --channel and --out" >&2; exit 1; }
mkdir -p "$(dirname "$OUT")"
CACHE="$(mktemp -d /tmp/p18-trace-XXXX)"
PAGE_URL="${BACKEND}/channel.html?channel=${CHANNEL}&engine=1&engine_fps=50&w=1920&h=1080"

export BG_TRACE_SECONDS="$DURATION"
export BG_TRACE_CATEGORIES="$CATEGORIES"
export BG_NUM_RASTER_THREADS="$NUM_RASTER_THREADS"

CMD=("$BIN" --name=p18-trace --url="$PAGE_URL" --width=1920 --height=1080 --fps=50 \
  --duration=$((DURATION + 5)) --stats-interval=5 --consumer=null \
  --cache-dir="$CACHE" --blink-research=1)

if [[ -n "$CORES" ]]; then
  CMD=(taskset -c "$CORES" "${CMD[@]}")
fi

echo "[p18-trace] categories=${CATEGORIES} duration=${DURATION}s cache=${CACHE}"
"${CMD[@]}" >"${OUT%.json}.engine.log" 2>&1 || true

# Chromium writes trace-startup*.json into cache_path
TRACE_SRC="$(find "$CACHE" -name 'trace-startup*.json' -o -name '*.json' 2>/dev/null | head -1 || true)"
if [[ -z "$TRACE_SRC" ]]; then
  # Also check for chrome-trace / chrometrace naming
  TRACE_SRC="$(find "$CACHE" -type f -name '*.json' 2>/dev/null | head -1 || true)"
fi
if [[ -n "$TRACE_SRC" ]]; then
  cp -f "$TRACE_SRC" "$OUT"
  echo "[p18-trace] copied $TRACE_SRC -> $OUT ($(wc -c < "$OUT") bytes)"
else
  echo "[p18-trace] NO TRACE FILE in $CACHE — listing:" >&2
  find "$CACHE" -type f | head -40 >&2
  exit 1
fi

if [[ "$DO_PARSE" -eq 1 ]]; then
  node "${ROOT}/engine/research/parse-chrome-trace.mjs" \
    --in="$OUT" --out="${OUT%.json}-parsed.json" \
    --out-csv="${OUT%.json}-parsed.csv" | tee "${OUT%.json}-parsed.txt"
fi

echo "[p18-trace] cache left at $CACHE (not auto-removed)"
