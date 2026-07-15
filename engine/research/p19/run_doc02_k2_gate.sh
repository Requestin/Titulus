#!/usr/bin/env bash
# Phase 19 Doc02 K2 — paired DeckLink gate for layered compositor.
# Usage:
#   run_doc02_k2_gate.sh 1ch|3ch off|on [duration_sec]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MODE="${1:?usage: $0 1ch|3ch off|on [duration]}"
VARIANT="${2:?off|on}"
DURATION="${3:-90}"
BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:3003}"
TOKEN="${TOKEN:-$(cat /tmp/titulus-doc04-setup/token 2>/dev/null || true)}"
TEMPLATE_JSON="${TEMPLATE_JSON:-/tmp/titulus-doc04-setup/test1.json}"
OUT_ROOT="${OUT_ROOT:-/tmp/titulus-doc02-k2}"
LOCK="/tmp/titulus-doc04-decklink.lock"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="${OUT_ROOT}/${MODE}-${VARIANT}-${STAMP}"
PARSER="${ROOT}/engine/research/p19/parse_doc04_telemetry.py"

mkdir -p "$OUT_ROOT"

if [[ -z "$TOKEN" ]]; then
  echo "TOKEN missing" >&2
  exit 1
fi
if [[ ! -f "$TEMPLATE_JSON" ]]; then
  echo "template missing: $TEMPLATE_JSON" >&2
  exit 1
fi
if [[ -e "$LOCK" ]]; then
  # Stale empty lock from prior sessions — remove if no bg_engine running.
  if pgrep -f '/engine/build/Release/bg_engine' >/dev/null 2>&1; then
    echo "DeckLink lock held and engines running: $LOCK" >&2
    exit 1
  fi
  rm -f "$LOCK"
fi

mkdir -p "$RUN_DIR"
echo $$ >"$LOCK"
cleanup() {
  rm -f "$LOCK"
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  pkill -f '/engine/build/Release/bg_engine' 2>/dev/null || true
  pkill -f 'engine/run-channel.sh' 2>/dev/null || true
}
trap cleanup EXIT

mapfile -t ALL_CH < <(tr ' ' '\n' </tmp/titulus-doc04-setup/channel-ids | sed '/^$/d')
if [[ "${#ALL_CH[@]}" -lt 3 ]]; then
  echo "need 3 channel ids in /tmp/titulus-doc04-setup/channel-ids" >&2
  exit 1
fi

case "$MODE" in
  1ch) CHANNELS=("${ALL_CH[0]}") ;;
  3ch) CHANNELS=("${ALL_CH[@]}") ;;
  *) echo "mode must be 1ch|3ch" >&2; exit 1 ;;
esac

case "$VARIANT" in
  off) export BG_LAYERED_COMPOSITOR=0 ;;
  on)  export BG_LAYERED_COMPOSITOR=1 ;;
  *) echo "variant must be off|on" >&2; exit 1 ;;
esac

echo "[doc02-k2] mode=$MODE variant=$VARIANT duration=${DURATION}s layered=$BG_LAYERED_COMPOSITOR"
echo "[doc02-k2] channels=${CHANNELS[*]}"
echo "[doc02-k2] out=$RUN_DIR"
echo "mode=$MODE variant=$VARIANT duration=$DURATION layered=$BG_LAYERED_COMPOSITOR" >"$RUN_DIR/meta.txt"
printf '%s\n' "${CHANNELS[@]}" >"$RUN_DIR/channels.txt"

pkill -f '/engine/build/Release/bg_engine' 2>/dev/null || true
pkill -f 'engine/run-channel.sh' 2>/dev/null || true
sleep 2

export BACKEND_URL
ENGINE_LOG_DIR="$RUN_DIR/engine-logs"
mkdir -p "$ENGINE_LOG_DIR"

CORES_LIST=("0-3" "4-7" "8-11")
DEVICE_LIST=(1 2 3)
NAMES=("doc04-ch0" "doc04-ch1" "doc04-ch2")

PIDS=()
for ch in "${CHANNELS[@]}"; do
  idx=-1
  for j in "${!ALL_CH[@]}"; do
    if [[ "${ALL_CH[$j]}" == "$ch" ]]; then idx=$j; break; fi
  done
  if [[ $idx -lt 0 ]]; then echo "channel not found: $ch" >&2; exit 1; fi
  name="${NAMES[$idx]}"
  cores="${CORES_LIST[$idx]}"
  device="${DEVICE_LIST[$idx]}"
  log="$ENGINE_LOG_DIR/${name}.log"
  # Also symlink into logs/ as engine-*.log for parser familiarity
  echo "[doc02-k2] start $name device=$device cores=$cores layered=$BG_LAYERED_COMPOSITOR"
  (
    export BG_LAYERED_COMPOSITOR
    exec "$ROOT/engine/run-channel.sh" \
      --id="$ch" \
      --name="$name" \
      --cores="$cores" \
      --output-mode=decklink \
      --device-index="$device" \
      --display-mode=HD1080i50 \
      --keyer=fill_only \
      >"$log" 2>&1
  ) &
  PIDS+=($!)
done

echo "[doc02-k2] waiting for DeckLink ready..."
ready=0
for _ in $(seq 1 90); do
  hits=0
  for f in "$ENGINE_LOG_DIR"/*.log; do
    [[ -f "$f" ]] || continue
    if grep -qE 'DeckLink output started|Display mode set|HD1080i50|consumer=decklink' "$f" 2>/dev/null; then
      hits=$((hits + 1))
    fi
  done
  if [[ "$hits" -ge "${#CHANNELS[@]}" ]]; then
    ready=1
    break
  fi
  sleep 1
done

if [[ "$ready" -ne 1 ]]; then
  echo "[doc02-k2] engines not ready; dumping tails:" >&2
  tail -n 60 "$ENGINE_LOG_DIR"/*.log >&2 || true
  exit 1
fi
echo "[doc02-k2] engines ready (hits ok)"

# Confirm layered flag in logs
grep -H 'layered' "$ENGINE_LOG_DIR"/*.log | head -20 | tee "$RUN_DIR/layered-boot.txt" || true

for ch in "${CHANNELS[@]}"; do
  echo "[doc02-k2] take test1 -> $ch"
  node "$ROOT/backend/p15-take.mjs" "$ch" "$TEMPLATE_JSON" "$TOKEN" | tee -a "$RUN_DIR/takes.log"
done

echo "[doc02-k2] settle 8s then measure ${DURATION}s"
sleep 8
echo "[doc02-k2] measuring..."
sleep "$DURATION"

# Copy logs for archival and parse
mkdir -p "$RUN_DIR/raw-logs"
cp "$ENGINE_LOG_DIR"/*.log "$RUN_DIR/raw-logs/"
python3 "$PARSER" "$RUN_DIR/raw-logs"/*.log --out "$RUN_DIR/telemetry-summary.json"
python3 - <<'PY' "$RUN_DIR/telemetry-summary.json" "$RUN_DIR/SUMMARY.txt"
import json, sys
from pathlib import Path
data = json.loads(Path(sys.argv[1]).read_text())
lines = ["=== DOC02 K2 SUMMARY ==="]
medians = []
for ch in data["channels"]:
    med = ch["in_fps"]["median"]
    medians.append(med)
    lines.append(
        f"{Path(ch['log']).name}: windows={ch['windows']} "
        f"in_fps med={med} avg={ch['in_fps']['average']} "
        f"min={ch['in_fps']['minimum']} max={ch['in_fps']['maximum']} "
        f"late={ch['d_late_sum']} drop={ch['d_dropped_sum']} flush={ch['d_flushed_sum']} "
        f"unlock={ch['ref_unlock_windows']}"
    )
worst = min(medians) if medians else None
lines.append(f"worst_channel_median_in_fps={worst}")
text = "\n".join(lines) + "\n"
Path(sys.argv[2]).write_text(text)
print(text)
PY

echo "[doc02-k2] done -> $RUN_DIR"
echo "$RUN_DIR" >"$OUT_ROOT/last-run"
