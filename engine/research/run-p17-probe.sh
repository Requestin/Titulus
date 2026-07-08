#!/usr/bin/env bash
# engine/research/run-p17-probe.sh — run a single bg_engine channel with
# --frame-log + per-thread CPU sampling, for Phase 17 P1/P2/P4 measurements.
#
# Handles two footguns discovered during P1:
#   1. `pgrep -f` self-matches this very shell invocation's own argv when the
#      search pattern is a plain substring (e.g. the cache-dir name) — this
#      script instead filters `ps -eo pid,comm,cmd` on comm=="bg_engine",
#      which the wrapper shell never has.
#   2. CEF keeps a second, near-idle renderer process alive alongside the one
#      actually compositing the page (a spare-process-style artifact) — this
#      script disambiguates by comparing utime+stime deltas over ~3s and
#      samples the one that's actually burning CPU.
#
# Usage:
#   run-p17-probe.sh --consumer=null|decklink --duration=SEC --out-dir=DIR \
#     --channel=CHANNEL_ID [--device-index=N] [--cores=0,6,1,7] \
#     [--backend=http://127.0.0.1:3003] [--bin=engine/build-p17/Release/bg_engine] \
#     [--num-raster-threads=N] [--label=name]
#
# Output (in --out-dir): <label>.log, <label>-frame-log.csv,
#   <label>-threads.csv, <label>-threads.log, <label>-framelog.json
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

CONSUMER="null"
DURATION=60
OUT_DIR=""
CHANNEL=""
DEVICE_INDEX=-1
CORES=""
BACKEND="http://127.0.0.1:3003"
BIN="${ROOT}/engine/build-p17/Release/bg_engine"
NUM_RASTER_THREADS=""
LABEL="probe"

for arg in "$@"; do
  case "$arg" in
    --consumer=*) CONSUMER="${arg#*=}" ;;
    --duration=*) DURATION="${arg#*=}" ;;
    --out-dir=*) OUT_DIR="${arg#*=}" ;;
    --channel=*) CHANNEL="${arg#*=}" ;;
    --device-index=*) DEVICE_INDEX="${arg#*=}" ;;
    --cores=*) CORES="${arg#*=}" ;;
    --backend=*) BACKEND="${arg#*=}" ;;
    --bin=*) BIN="${arg#*=}" ;;
    --num-raster-threads=*) NUM_RASTER_THREADS="${arg#*=}" ;;
    --label=*) LABEL="${arg#*=}" ;;
    *) echo "run-p17-probe.sh: unknown arg $arg" >&2; exit 1 ;;
  esac
done

[[ -n "$OUT_DIR" && -n "$CHANNEL" ]] || { echo "Usage: --out-dir and --channel required" >&2; exit 1; }
mkdir -p "$OUT_DIR"
CACHE_DIR="$(mktemp -d "/tmp/p17-probe-${LABEL}-XXXX")"

PAGE_URL="${BACKEND}/channel.html?channel=${CHANNEL}&engine=1&engine_fps=50&w=1920&h=1080"
FRAME_LOG="${OUT_DIR}/${LABEL}-frame-log.csv"
ENGINE_LOG="${OUT_DIR}/${LABEL}.log"
THREADS_CSV="${OUT_DIR}/${LABEL}-threads.csv"
THREADS_LOG="${OUT_DIR}/${LABEL}-threads.log"

EXTRA_ARGS=()
if [[ "$CONSUMER" == "decklink" ]]; then
  [[ "$DEVICE_INDEX" -ge 0 ]] || { echo "decklink consumer needs --device-index" >&2; exit 1; }
  EXTRA_ARGS+=(--device-index="$DEVICE_INDEX" --display-mode=HD1080i50 --keyer=fill_only)
fi

CMD=("$BIN" --name="p17-${LABEL}" --url="$PAGE_URL" --width=1920 --height=1080 --fps=50 \
     --duration="$DURATION" --stats-interval=10 --consumer="$CONSUMER" \
     --cache-dir="$CACHE_DIR" --frame-log="$FRAME_LOG" "${EXTRA_ARGS[@]}")

if [[ -n "$CORES" ]]; then
  CMD=(taskset -c "$CORES" "${CMD[@]}")
fi

echo "[p17-probe] ${LABEL}: consumer=${CONSUMER} duration=${DURATION}s cache=${CACHE_DIR}"
if [[ -n "$NUM_RASTER_THREADS" ]]; then
  echo "[p17-probe] BG_NUM_RASTER_THREADS=${NUM_RASTER_THREADS}"
fi

BG_NUM_RASTER_THREADS="$NUM_RASTER_THREADS" nohup "${CMD[@]}" > "$ENGINE_LOG" 2>&1 < /dev/null &
MAIN_PID=$!
disown "$MAIN_PID" 2>/dev/null || true

# Give CEF a few seconds to fork the renderer process(es) before we look.
sleep 4

mapfile -t CANDIDATES < <(ps -eo pid,comm,cmd | awk -v cd="$CACHE_DIR" \
  '$2=="bg_engine" && $0 ~ /type=renderer/ && index($0, cd) { print $1 }')

ACTIVE=""
if [[ "${#CANDIDATES[@]}" -eq 1 ]]; then
  ACTIVE="${CANDIDATES[0]}"
elif [[ "${#CANDIDATES[@]}" -gt 1 ]]; then
  declare -A T1
  for p in "${CANDIDATES[@]}"; do
    T1[$p]="$(awk '{print $14+$15}' "/proc/$p/stat" 2>/dev/null || echo 0)"
  done
  sleep 3
  best_delta=-1
  for p in "${CANDIDATES[@]}"; do
    t2="$(awk '{print $14+$15}' "/proc/$p/stat" 2>/dev/null || echo 0)"
    delta=$(( t2 - ${T1[$p]:-0} ))
    if [[ "$delta" -gt "$best_delta" ]]; then best_delta="$delta"; ACTIVE="$p"; fi
  done
fi

if [[ -n "$ACTIVE" ]]; then
  echo "[p17-probe] sampling active renderer pid=${ACTIVE} for $(( DURATION - 8 > 5 ? DURATION - 8 : 5 ))s"
  nohup "${ROOT}/engine/research/sample-threads.sh" "$ACTIVE" \
    "$(( DURATION - 8 > 5 ? DURATION - 8 : 5 ))" "$THREADS_CSV" \
    > "$THREADS_LOG" 2>&1 < /dev/null &
  disown $! 2>/dev/null || true
else
  echo "[p17-probe] WARN: no renderer candidate found, skipping thread sampling" >&2
fi

# Wait for the engine to finish (poll — MAIN_PID belongs to a disowned bg job).
while kill -0 "$MAIN_PID" 2>/dev/null; do
  sleep 2
done

echo "[p17-probe] engine exited, waiting for sampler to flush"
sleep 3

if [[ -f "$FRAME_LOG" ]]; then
  node "${ROOT}/engine/research/analyze-frame-log.mjs" --in="$FRAME_LOG" \
    --out="${OUT_DIR}/${LABEL}-framelog.json" > "${OUT_DIR}/${LABEL}-framelog.txt" 2>&1 || true
  echo "[p17-probe] frame-log analysis -> ${LABEL}-framelog.txt"
fi

echo "[p17-probe] ${LABEL} done. cache=${CACHE_DIR} (not auto-removed, inspect if needed)"
