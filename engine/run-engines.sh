#!/usr/bin/env bash
# engine/run-engines.sh — multi-channel bg_engine supervisor (DEVELOPMENT_PROMPT §9.8).
#
# Reads channel config from GET /api/channels, launches one bg_engine per channel
# via run-channel.sh with disjoint taskset cores (2 physical cores per channel).
#
# Usage:
#   ./engine/run-engines.sh [--dry-run] [--help]
#
# Environment:
#   BACKEND_URL   default http://127.0.0.1:3001
#   ENGINE_BIN    default engine/build/Release/bg_engine
#   CACHE_ROOT    default /tmp/titulus-engines

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_CHANNEL="${ROOT}/engine/run-channel.sh"
BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:3001}"
ENGINE_BIN="${ENGINE_BIN:-${ROOT}/engine/build/Release/bg_engine}"
CACHE_ROOT="${CACHE_ROOT:-/tmp/titulus-engines}"
DRY_RUN=0

usage() {
  cat <<EOF
Titulus multi-channel engine supervisor (DEVELOPMENT_PROMPT §9.8)

Usage: $(basename "$0") [options]

Options:
  --dry-run    Print planned run-channel.sh invocations; do not launch
  --help       Show this help

Fetches channels from: \${BACKEND_URL}/api/channels
Maps output_mode -> consumer:
  browser / obs_vmix  -> null (CEF renders; browser/OBS uses channel.html URL)
  decklink            -> decklink (--device-index, --display-mode, --keyer)
  stream              -> stream (--stream-url)

Supervisor (run-channel.sh): exit 42 -> 6s restart; crash -> 3s backoff.
CPU affinity: 2 dedicated physical cores per channel (taskset).

Environment: BACKEND_URL, ENGINE_BIN, CACHE_ROOT
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "run-engines.sh: unknown option $1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

if [[ ! -x "$RUN_CHANNEL" ]]; then
  echo "run-engines.sh: missing $RUN_CHANNEL" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "run-engines.sh: curl required" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "run-engines.sh: python3 required (JSON parse)" >&2
  exit 1
fi

echo "[run-engines] fetching channels from ${BACKEND_URL}/api/channels"
JSON="$(curl -sf "${BACKEND_URL}/api/channels")" || {
  echo "run-engines.sh: failed to fetch channels (is backend running at ${BACKEND_URL}?)" >&2
  exit 1
}

COUNT="$(python3 -c "import json,sys; print(len(json.load(sys.stdin)))" <<<"$JSON")"
if [[ "$COUNT" -eq 0 ]]; then
  echo "[run-engines] no channels configured — create channels in Settings first" >&2
  exit 0
fi

# Physical core discovery (same as bench/run-bench.sh).
phys_cores="$(lscpu 2>/dev/null | awk '/^Core\(s\) per socket:/ {c=$4} /^Socket\(s\):/ {s=$4} END {print c*s}')"
if [[ -z "$phys_cores" || "$phys_cores" -eq 0 ]]; then
  phys_cores="$(nproc)"
fi
cores_per_channel=2
total_needed=$((COUNT * cores_per_channel))
if [[ "$phys_cores" -lt "$total_needed" ]]; then
  echo "[run-engines] WARNING: ${phys_cores} physical cores < ${total_needed} needed for ${COUNT}ch @${cores_per_channel}c/ch" >&2
fi
echo "[run-engines] ${COUNT} channel(s); host ${phys_cores} physical cores; pinning ${cores_per_channel}/ch"

mkdir -p "$CACHE_ROOT"

# Emit one run-channel.sh line per channel with disjoint core ranges.
core=0
while IFS= read -r line; do
  eval "$line"
  core_start=$core
  core_end=$((core + cores_per_channel - 1))
  cores="${core_start}-${core_end}"

  args=(
    "$RUN_CHANNEL"
    --id="$ch_id"
    --name="$ch_name"
    --output-mode="$output_mode"
    --device-index="$device_index"
    --display-mode="$display_mode"
    --keyer="$keyer_mode"
    --stream-url="$stream_url"
    --cores="$cores"
  )
  if [[ "$DRY_RUN" -eq 1 ]]; then
    args+=(--dry-run)
    DRY_RUN=1 BACKEND_URL="$BACKEND_URL" ENGINE_BIN="$ENGINE_BIN" CACHE_ROOT="$CACHE_ROOT" "${args[@]}"
  else
    echo "[run-engines] launching ${ch_name} on cores ${cores} (mode=${output_mode})"
    BACKEND_URL="$BACKEND_URL" ENGINE_BIN="$ENGINE_BIN" CACHE_ROOT="$CACHE_ROOT" \
      "${args[@]}" &
  fi
  core=$((core + cores_per_channel))
done < <(python3 -c "
import json, sys, shlex
channels = json.load(sys.stdin)
for c in channels:
    line = ' '.join([
        f'ch_id={shlex.quote(c[\"id\"])}',
        f'ch_name={shlex.quote(c[\"name\"])}',
        f'output_mode={shlex.quote(c[\"output_mode\"])}',
        f'device_index={c.get(\"device_index\", -1)}',
        f'display_mode={shlex.quote(c.get(\"display_mode\", \"HD1080i50\"))}',
        f'keyer_mode={shlex.quote(c.get(\"keyer_mode\", \"external\"))}',
        f'stream_url={shlex.quote(c.get(\"stream_url\", \"\"))}',
    ])
    print(line)
" <<<"$JSON")

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[run-engines] dry-run complete (${COUNT} channel(s))"
  exit 0
fi

echo "[run-engines] ${COUNT} supervisor(s) running — Ctrl+C to stop all"
wait
