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
#   TITULUS_API_TOKEN     optional bearer token for protected API
#   TITULUS_API_USER      default admin (used when token absent)
#   TITULUS_API_PASSWORD  default admin123 (used when token absent)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_CHANNEL="${ROOT}/engine/run-channel.sh"
RUN_VS_CHANNEL="${ROOT}/engine/run-vs-channel.sh"
BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:3001}"
ENGINE_BIN="${ENGINE_BIN:-${ROOT}/engine/build/Release/bg_engine}"
VS_BIN="${VS_BIN:-${ROOT}/engine/build/Release/bg_vs_engine}"
CACHE_ROOT="${CACHE_ROOT:-/tmp/titulus-engines}"
API_TOKEN="${TITULUS_API_TOKEN:-}"
DRY_RUN=0

usage() {
  cat <<EOF
Titulus multi-channel engine supervisor (DEVELOPMENT_PROMPT §9.8)

Usage: $(basename "$0") [options]

Options:
  --dry-run    Print planned run-channel.sh invocations; do not launch
  --help       Show this help

Fetches channels from: \${BACKEND_URL}/api/channels
Maps render_backend + output_mode:
  html   + browser/obs_vmix/decklink/stream -> run-channel.sh (bg_engine)
  unreal + …                              -> run-vs-channel.sh (bg_vs_engine)
See docs/unreal-vs-mode.md

Supervisor (run-channel.sh / run-vs-channel.sh): exit 42 -> 6s restart; crash -> 3s backoff.
CPU affinity: 2 dedicated physical cores per channel (taskset).

Environment: BACKEND_URL, ENGINE_BIN, VS_BIN, CACHE_ROOT, TITULUS_API_TOKEN,
             TITULUS_API_USER, TITULUS_API_PASSWORD
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

if [[ -z "${API_TOKEN}" ]]; then
  API_USER="${TITULUS_API_USER:-admin}"
  API_PASSWORD="${TITULUS_API_PASSWORD:-admin123}"
  login_payload="$(API_USER="$API_USER" API_PASSWORD="$API_PASSWORD" python3 -c "import json, os; print(json.dumps({'username': os.environ['API_USER'], 'password': os.environ['API_PASSWORD']}))")"
  login_resp="$(curl -sf -H 'Content-Type: application/json' -d "$login_payload" "${BACKEND_URL}/api/auth/login" || true)"
  if [[ -n "$login_resp" ]]; then
    API_TOKEN="$(python3 -c "import json,sys; print(json.load(sys.stdin).get('token',''))" <<<"$login_resp" 2>/dev/null || true)"
  fi
fi

if [[ -z "${API_TOKEN}" ]]; then
  echo "run-engines.sh: missing API token; set TITULUS_API_TOKEN or TITULUS_API_USER/TITULUS_API_PASSWORD" >&2
  exit 1
fi

JSON="$(curl -sf -H "Authorization: Bearer ${API_TOKEN}" "${BACKEND_URL}/api/channels")" || {
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

  render_backend="${render_backend:-html}"
  vs_input_device="${vs_input_device:--1}"
  vs_cam_file="${vs_cam_file:-}"
  vs_bg_file="${vs_bg_file:-}"
  unreal_ndi_source="${unreal_ndi_source:-}"

  args_common=(
    --id="$ch_id"
    --name="$ch_name"
    --output-mode="$output_mode"
    --device-index="$device_index"
    --display-mode="$display_mode"
    --keyer="$keyer_mode"
    --stream-url="$stream_url"
    --cores="$cores"
  )

  if [[ "$render_backend" == "unreal" ]]; then
    launcher="$RUN_VS_CHANNEL"
    args=(
      "$launcher"
      "${args_common[@]}"
      --vs-input-device="$vs_input_device"
      --cam-file="$vs_cam_file"
      --bg-file="$vs_bg_file"
      --ndi-source="$unreal_ndi_source"
    )
  else
    launcher="$RUN_CHANNEL"
    args=(
      "$launcher"
      "${args_common[@]}"
    )
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    args+=(--dry-run)
    DRY_RUN=1 BACKEND_URL="$BACKEND_URL" ENGINE_BIN="$ENGINE_BIN" VS_BIN="$VS_BIN" CACHE_ROOT="$CACHE_ROOT" "${args[@]}"
  else
    echo "[run-engines] launching ${ch_name} on cores ${cores:--} (backend=${render_backend} mode=${output_mode})"
    BACKEND_URL="$BACKEND_URL" ENGINE_BIN="$ENGINE_BIN" VS_BIN="$VS_BIN" CACHE_ROOT="$CACHE_ROOT" \
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
        f'render_backend={shlex.quote(c.get(\"render_backend\", \"html\"))}',
        f'device_index={c.get(\"device_index\", -1)}',
        f'display_mode={shlex.quote(c.get(\"display_mode\", \"HD1080i50\"))}',
        f'keyer_mode={shlex.quote(c.get(\"keyer_mode\", \"external\"))}',
        f'stream_url={shlex.quote(c.get(\"stream_url\", \"\"))}',
        f'vs_input_device={c.get(\"vs_input_device\", -1)}',
        f'vs_cam_file={shlex.quote(c.get(\"vs_cam_file\", \"\"))}',
        f'vs_bg_file={shlex.quote(c.get(\"vs_bg_file\", \"\"))}',
        f'unreal_ndi_source={shlex.quote(c.get(\"unreal_ndi_source\", \"\"))}',
    ])
    print(line)
" <<<"$JSON")

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[run-engines] dry-run complete (${COUNT} channel(s))"
  exit 0
fi

echo "[run-engines] ${COUNT} supervisor(s) running — Ctrl+C to stop all"
wait
