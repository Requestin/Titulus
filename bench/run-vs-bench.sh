#!/usr/bin/env bash
# bench/run-vs-bench.sh — smoke / latency bench for bg_vs_engine (no DeckLink HW required).
#
# Usage:
#   ./bench/run-vs-bench.sh [duration_sec] [mode]
#   mode: chroma (default) | passthrough
#
# Emits SUMMARY from bg_vs_engine for harness parsing. CPU chroma is functional
# only; production VS assumes GPU Unreal + optional GPU key (docs/GPU_GATE_unreal_vs.md).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VS_BIN="${VS_BIN:-${ROOT}/engine/build/Release/bg_vs_engine}"
DUR="${1:-5}"
MODE="${2:-chroma}"

if [[ ! -x "$VS_BIN" ]]; then
  echo "run-vs-bench.sh: build bg_vs_engine first" >&2
  echo "  cd engine && cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build --target bg_vs_engine -j" >&2
  exit 1
fi

ARGS=(
  --name=vs-bench
  --consumer=null
  --width=1920 --height=1080 --fps=50
  --duration="$DUR"
  --stats-interval=2
  --vs-input-device=-1
)

if [[ "$MODE" == "passthrough" ]]; then
  ARGS+=(--passthrough)
  echo "[run-vs-bench] passthrough (BG stub only) duration=${DUR}s"
else
  echo "[run-vs-bench] chroma MVP (synthetic green_screen + flat BG) duration=${DUR}s"
fi

# Capture SUMMARY line
set +e
OUT="$("$VS_BIN" "${ARGS[@]}" 2>&1)"
code=$?
set -e
echo "$OUT"
if echo "$OUT" | grep -q 'SUMMARY'; then
  echo "[run-vs-bench] OK (exit=${code})"
  exit 0
fi
echo "[run-vs-bench] WARNING: no SUMMARY line (exit=${code})" >&2
exit "$code"
