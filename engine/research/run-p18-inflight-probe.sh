#!/usr/bin/env bash
# engine/research/run-p18-inflight-probe.sh — Phase 18 P0.2 dual-BeginFrame probe.
#
# Wraps run-p17-probe.sh with BG_P18_PIPELINE_PROBE=1 so the self-timer path
# fires two SendExternalBeginFrame() calls per tick and records paint_seq_delta
# in the frame-log CSV. Then runs analyze-p18-inflight.mjs.
#
# Usage: same flags as run-p17-probe.sh. Example:
#   ./engine/research/run-p18-inflight-probe.sh --consumer=null --duration=60 \
#     --cores=0,6,1,7 --channel=CH --backend=http://127.0.0.1:3003 \
#     --bin=engine/build-p18/Release/bg_engine \
#     --out-dir=engine/research/results/p18 --label=p02-inflight-r1 \
#     --num-raster-threads=3
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export BG_P18_PIPELINE_PROBE=1

# Extract --out-dir and --label for post-analysis
OUT_DIR=""
LABEL="probe"
for arg in "$@"; do
  case "$arg" in
    --out-dir=*) OUT_DIR="${arg#*=}" ;;
    --label=*) LABEL="${arg#*=}" ;;
  esac
done

echo "[p18-inflight] BG_P18_PIPELINE_PROBE=1"
"${ROOT}/engine/research/run-p17-probe.sh" "$@"

FRAME_LOG="${OUT_DIR}/${LABEL}-frame-log.csv"
REPORT_JSON="${OUT_DIR}/${LABEL}-inflight.json"
REPORT_TXT="${OUT_DIR}/${LABEL}-inflight.txt"
if [[ -f "$FRAME_LOG" ]]; then
  node "${ROOT}/engine/research/analyze-p18-inflight.mjs" \
    --in="$FRAME_LOG" --out="$REPORT_JSON" | tee "$REPORT_TXT"
else
  echo "[p18-inflight] missing frame-log: $FRAME_LOG" >&2
  exit 1
fi
