#!/usr/bin/env bash
# engine/research/p16/run-p16-bench.sh — run a single bench file headless and
# capture its blink-trace.json for Phase 16 P0/P1 matrix analysis.
#
# Usage: run-p16-bench.sh <bench-name> [duration_sec]
# Example: run-p16-bench.sh bench-clip-circle 20
#
# Output: engine/research/results/p16/<bench-name>.{json,csv,txt}
# Uses the existing engine/build-p15/ binary (engine code unchanged in P16;
# only runtime/src/*.ts + bench/* change). trace categories: blink + cc.
set -euo pipefail

NAME="${1:?bench name required, e.g. bench-clip-circle}"
DUR="${2:-20}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BIN="$ROOT/engine/build-p15/Release/bg_engine"
BENCH="$ROOT/bench/${NAME}.html"
OUT="$ROOT/engine/research/results/p16"
CACHE="/tmp/p16-${NAME}"

mkdir -p "$OUT" "$CACHE"

if [[ ! -f "$BENCH" ]]; then
  echo "ERROR: $BENCH not found" >&2
  exit 1
fi

echo "[p16-bench] $NAME  dur=${DUR}s  -> $OUT"

# Clean any prior trace in cache so we don't parse a stale one.
rm -f "$CACHE/blink-trace.json"

# BG_TRACE_* env-vars come from Phase 15 P0 (engine_app.cpp). Categories
# cover Layout/Paint/Raster + cc sub-categories used by parse-chrome-trace.mjs.
BG_TRACE_CATEGORIES="blink,cc,disabled-by-default-cc.debug" \
BG_TRACE_SECONDS="$DUR" \
"$BIN" \
  --name="p16-${NAME}" \
  --url="file://${BENCH}" \
  --consumer=null \
  --cache-dir="$CACHE" \
  --fps=50 \
  --duration="$DUR" \
  --stats-interval=5 \
  > "$OUT/${NAME}.log" 2>&1 || true

# Trace is written to cache-dir/blink-trace.json on engine shutdown.
if [[ -f "$CACHE/blink-trace.json" ]]; then
  node "$ROOT/engine/research/lib/parse-chrome-trace.mjs" \
    --in="$CACHE/blink-trace.json" \
    --out="$OUT/${NAME}.json" \
    --out-csv="$OUT/${NAME}.csv" \
    > "$OUT/${NAME}.txt" 2>&1 || true
  echo "[p16-bench]   parsed -> ${NAME}.txt + ${NAME}.csv"
else
  echo "[p16-bench]   WARN: no trace file produced (see ${NAME}.log)"
fi
