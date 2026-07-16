#!/usr/bin/env bash
# Phase 19 Doc02 K2 — one controlled DeckLink measurement cell.
# Usage: run_doc02_k2_gate.sh 1ch|3ch off|on [measured_seconds]
#
# A caller supplies ABBA ordering. This script guarantees that one cell uses:
# - fresh CEF caches and tracked process groups;
# - a warmup excluded from telemetry;
# - exactly measured_seconds/5 complete telemetry5s windows;
# - strict field/path validation and treatment active-path proof.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MODE="${1:?usage: $0 1ch|3ch off|on [measured_seconds]}"
VARIANT="${2:?variant must be off|on}"
DURATION="${3:-60}"
WARMUP="${WARMUP:-20}"
BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:3003}"
TOKEN="${TOKEN:-$(< /tmp/titulus-doc04-setup/token 2>/dev/null || true)}"
TEMPLATE_JSON="${TEMPLATE_JSON:-/tmp/titulus-doc04-setup/test1.json}"
CHANNEL_IDS="${CHANNEL_IDS:-/tmp/titulus-doc04-setup/channel-ids}"
ENGINE_BIN="${ENGINE_BIN:-${ROOT}/engine/build/Release/bg_engine}"
OUT_ROOT="${OUT_ROOT:-/tmp/titulus-doc02-k2-audit}"
LOCK="/tmp/titulus-doc02-k2.lock"
PARSER="${ROOT}/engine/research/p19/parse_doc04_telemetry.py"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="${OUT_ROOT}/${MODE}-${VARIANT}-${STAMP}"

if [[ "$MODE" != "1ch" && "$MODE" != "3ch" ]]; then
  echo "mode must be 1ch|3ch" >&2
  exit 2
fi
if [[ "$VARIANT" != "off" && "$VARIANT" != "on" ]]; then
  echo "variant must be off|on" >&2
  exit 2
fi
if ! [[ "$DURATION" =~ ^[0-9]+$ ]] || (( DURATION < 30 || DURATION % 5 != 0 )); then
  echo "measured_seconds must be an integer >=30 divisible by 5" >&2
  exit 2
fi
if ! [[ "$WARMUP" =~ ^[0-9]+$ ]] || (( WARMUP < 10 )); then
  echo "WARMUP must be an integer >=10" >&2
  exit 2
fi
for required in "$TOKEN" "$TEMPLATE_JSON" "$CHANNEL_IDS" "$ENGINE_BIN" "$PARSER"; do
  if [[ -z "$required" || ( "$required" != "$TOKEN" && ! -e "$required" ) ]]; then
    echo "missing prerequisite: ${required:-TOKEN}" >&2
    exit 1
  fi
done

if [[ -e "$LOCK" ]]; then
  owner="$(<"$LOCK" 2>/dev/null || true)"
  if [[ "$owner" =~ ^[0-9]+$ ]] && kill -0 "$owner" 2>/dev/null; then
    echo "another Doc02 K2 run owns $LOCK (pid=$owner)" >&2
    exit 1
  fi
  rm -f "$LOCK"
fi
if pgrep -f "${ROOT}/engine/(build/Release/bg_engine|run-channel.sh)" >/dev/null; then
  echo "pre-existing Titulus engine processes detected; stop them before K2" >&2
  pgrep -af "${ROOT}/engine/(build/Release/bg_engine|run-channel.sh)" >&2 || true
  exit 1
fi

mkdir -p "$RUN_DIR"
printf '%s\n' "$$" >"$LOCK"
PIDS=()

stop_engines() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    kill -TERM -- "-$pid" 2>/dev/null || true
  done
  for _ in $(seq 1 40); do
    local alive=0
    for pid in "${PIDS[@]:-}"; do
      if kill -0 "$pid" 2>/dev/null; then alive=1; fi
    done
    if (( alive == 0 )); then break; fi
    sleep 0.25
  done
  for pid in "${PIDS[@]:-}"; do
    kill -KILL -- "-$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  PIDS=()
}

cleanup() {
  stop_engines
  if [[ -e "$LOCK" && "$(<"$LOCK" 2>/dev/null || true)" == "$$" ]]; then
    rm -f "$LOCK"
  fi
}
trap cleanup EXIT INT TERM

mapfile -t ALL_CHANNELS < <(awk 'NF { print $1 }' "$CHANNEL_IDS")
if (( ${#ALL_CHANNELS[@]} < 3 )); then
  echo "need at least three channel ids in $CHANNEL_IDS" >&2
  exit 1
fi
if [[ "$MODE" == "1ch" ]]; then
  CHANNELS=("${ALL_CHANNELS[0]}")
else
  CHANNELS=("${ALL_CHANNELS[@]:0:3}")
fi

LAYERED=0
if [[ "$VARIANT" == "on" ]]; then LAYERED=1; fi
WINDOWS=$((DURATION / 5))
CORES_LIST=("0-3" "4-7" "8-11")
DEVICE_LIST=(1 2 3)
NAMES=("doc02-ch0" "doc02-ch1" "doc02-ch2")
ENGINE_LOG_DIR="$RUN_DIR/engine-logs"
MEASURE_LOG_DIR="$RUN_DIR/measurement-logs"
CACHE_ROOT="$RUN_DIR/cef-cache"
mkdir -p "$ENGINE_LOG_DIR" "$MEASURE_LOG_DIR" "$CACHE_ROOT"

{
  echo "mode=$MODE"
  echo "variant=$VARIANT"
  echo "measured_seconds=$DURATION"
  echo "warmup_seconds=$WARMUP"
  echo "telemetry_windows=$WINDOWS"
  echo "layered=$LAYERED"
  echo "backend_url=$BACKEND_URL"
  echo "engine_bin=$ENGINE_BIN"
  echo "engine_sha256=$(sha256sum "$ENGINE_BIN" | awk '{print $1}')"
  echo "git_head=$(git -C "$ROOT" rev-parse HEAD)"
  echo "git_diff_sha256=$(git -C "$ROOT" diff --binary | sha256sum | awk '{print $1}')"
  echo "cpu_governor=$(awk '{print}' /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null || echo unknown)"
} >"$RUN_DIR/meta.txt"
git -C "$ROOT" status --short >"$RUN_DIR/git-status.txt"
printf '%s\n' "${CHANNELS[@]}" >"$RUN_DIR/channels.txt"

# Fail before touching DeckLink if canonical media cannot be fetched.
python3 - "$TEMPLATE_JSON" >"$RUN_DIR/asset-urls.txt" <<'PY'
import json, sys
for layer in json.load(open(sys.argv[1], encoding="utf-8")).get("layers", []):
    if layer.get("type") in {"image", "video"}:
        src = layer.get("src")
        if not isinstance(src, str) or not src:
            raise SystemExit(f"missing media src for {layer.get('id')}")
        print(src)
PY
while IFS= read -r src; do
  curl -fsS -o /dev/null "${BACKEND_URL}${src}"
done <"$RUN_DIR/asset-urls.txt"

export BACKEND_URL
export ENGINE_BIN
export CACHE_ROOT
export BG_LAYERED_COMPOSITOR="$LAYERED"

for channel in "${CHANNELS[@]}"; do
  idx=-1
  for candidate in "${!ALL_CHANNELS[@]}"; do
    if [[ "${ALL_CHANNELS[$candidate]}" == "$channel" ]]; then idx=$candidate; break; fi
  done
  if (( idx < 0 || idx > 2 )); then
    echo "channel not mapped to fixed host slot: $channel" >&2
    exit 1
  fi
  log="$ENGINE_LOG_DIR/${NAMES[$idx]}.log"
  echo "[doc02-k2] start ${NAMES[$idx]} device=${DEVICE_LIST[$idx]} cores=${CORES_LIST[$idx]}"
  setsid env BG_LAYERED_COMPOSITOR="$LAYERED" \
    "$ROOT/engine/run-channel.sh" \
      --id="$channel" \
      --name="${NAMES[$idx]}" \
      --cores="${CORES_LIST[$idx]}" \
      --output-mode=decklink \
      --device-index="${DEVICE_LIST[$idx]}" \
      --display-mode=HD1080i50 \
      --keyer=fill_only \
      >"$log" 2>&1 &
  PIDS+=("$!")
done

ready=0
for _ in $(seq 1 120); do
  hits=0
  for log in "$ENGINE_LOG_DIR"/*.log; do
    if grep -q 'started mode=HD1080i50.*low_latency=yes' "$log" \
        && grep -q 'reference signal locked' "$log"; then
      hits=$((hits + 1))
    fi
  done
  if (( hits == ${#CHANNELS[@]} )); then ready=1; break; fi
  sleep 1
done
if (( ready == 0 )); then
  echo "DeckLink channels did not reach started+locked state" >&2
  exit 1
fi

: >"$RUN_DIR/takes.log"
for channel in "${CHANNELS[@]}"; do
  take_output="$(node "$ROOT/backend/p15-take.mjs" "$channel" "$TEMPLATE_JSON" "$TOKEN" 2>&1)"
  printf '%s\n' "$take_output" | tee -a "$RUN_DIR/takes.log"
  if [[ "$take_output" == *'"type":"error"'* || "$take_output" != *"[take] sent take"* ]]; then
    echo "TAKE failed for $channel" >&2
    exit 1
  fi
done

echo "[doc02-k2] warmup ${WARMUP}s"
sleep "$WARMUP"

declare -A START_LINES
for log in "$ENGINE_LOG_DIR"/*.log; do
  START_LINES["$log"]="$(wc -l <"$log")"
done

echo "[doc02-k2] collect $WINDOWS complete telemetry windows"
# One leading telemetry window can straddle the marker. Wait for the actual
# record count on every channel instead of estimating wall time: long soaks can
# accumulate enough 5s logger drift to miss multiple nominal boundaries.
REQUIRED_RECORDS=$((WINDOWS + 1))
DEADLINE=$((SECONDS + DURATION + 120))
while true; do
  complete=1
  for log in "$ENGINE_LOG_DIR"/*.log; do
    count="$(awk -v first="${START_LINES[$log]}" \
      'NR > first && /telemetry5s/ { n += 1 } END { print n + 0 }' "$log")"
    if (( count < REQUIRED_RECORDS )); then
      complete=0
      break
    fi
  done
  if (( complete == 1 )); then break; fi
  if (( SECONDS >= DEADLINE )); then
    echo "timed out waiting for ${REQUIRED_RECORDS} telemetry records" >&2
    exit 1
  fi
  sleep 2
done
stop_engines

# stdout is block-buffered when redirected, so prove the parsed feature flag
# only after graceful engine shutdown has flushed the startup config line.
for log in "$ENGINE_LOG_DIR"/*.log; do
  if ! grep -q "layered=${VARIANT}" "$log"; then
    echo "boot flag proof missing in $log" >&2
    exit 1
  fi
done

for log in "$ENGINE_LOG_DIR"/*.log; do
  out="$MEASURE_LOG_DIR/$(basename "$log")"
  awk -v first="${START_LINES[$log]}" 'NR > first' "$log" >"$out"
done

python3 "$PARSER" "$MEASURE_LOG_DIR"/*.log \
  --skip-first 1 \
  --take-windows "$WINDOWS" \
  --min-windows "$WINDOWS" \
  --out "$RUN_DIR/telemetry-summary.json"

python3 - "$VARIANT" "$ENGINE_LOG_DIR"/*.log \
  >"$RUN_DIR/layered-active-proof.txt" <<'PY'
import re, sys
variant, *paths = sys.argv[1:]
for path in paths:
    lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
    stats = [line for line in lines if "layered_stats " in line]
    if variant == "off":
        if stats:
            raise SystemExit(f"{path}: layered_stats present in control")
        print(f"{path}: control path confirmed (no layered_stats)")
        continue
    if not stats:
        raise SystemExit(f"{path}: no layered_stats active-path proof")
    last = stats[-1]
    values = dict(re.findall(r"\b([a-z_]+)=([^ ]+)", last))
    required = {
        "mode": "composing",
        "capture_failures": "0",
        "fallback": "0",
    }
    for key, expected in required.items():
        if values.get(key) != expected:
            raise SystemExit(f"{path}: {key}={values.get(key)!r}, expected {expected!r}")
    if int(values.get("composed", "0")) <= 0:
        raise SystemExit(f"{path}: no composed frames")
    if int(values.get("capture_ready", "0")) < 8:
        raise SystemExit(f"{path}: incomplete layer capture: {values.get('capture_ready')}")
    print(last)
PY

python3 - "$RUN_DIR/telemetry-summary.json" "$RUN_DIR/SUMMARY.txt" <<'PY'
import json, sys
from pathlib import Path
data = json.loads(Path(sys.argv[1]).read_text())
lines = ["=== DOC02 K2 STRICT CELL ==="]
medians = []
for channel in data["channels"]:
    delivery_errors = {
        "late": channel["d_late_sum"],
        "drop": channel["d_dropped_sum"],
        "flush": channel["d_flushed_sum"],
        "unlock": channel["ref_unlock_windows"],
    }
    nonzero = {key: value for key, value in delivery_errors.items() if value != 0}
    if nonzero:
        raise SystemExit(
            f"{Path(channel['log']).name}: delivery gate failed: {nonzero}"
        )
    med = channel["in_fps"]["median"]
    medians.append(med)
    lines.append(
        f"{Path(channel['log']).name}: windows={channel['windows']} "
        f"in_fps med={med} avg={channel['in_fps']['average']} "
        f"min={channel['in_fps']['minimum']} max={channel['in_fps']['maximum']} "
        f"late={channel['d_late_sum']} drop={channel['d_dropped_sum']} "
        f"flush={channel['d_flushed_sum']} unlock={channel['ref_unlock_windows']}"
    )
lines.append(f"worst_channel_median_in_fps={min(medians)}")
text = "\n".join(lines) + "\n"
Path(sys.argv[2]).write_text(text)
print(text, end="")
PY

echo "$RUN_DIR" >"$OUT_ROOT/last-run"
echo "[doc02-k2] done: $RUN_DIR"
