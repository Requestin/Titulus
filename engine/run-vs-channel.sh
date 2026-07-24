#!/usr/bin/env bash
# engine/run-vs-channel.sh — launch bg_vs_engine for render_backend=unreal
# Docs: docs/unreal-vs-mode.md

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VS_BIN="${VS_BIN:-${ROOT}/engine/build/Release/bg_vs_engine}"
CORES="${CORES:-}"
DRY_RUN="${DRY_RUN:-0}"

usage() {
  cat <<'EOF'
Usage: run-vs-channel.sh --id=ID --name=NAME [options]

  --id=ID --name=NAME
  --output-mode=browser|obs_vmix|decklink|stream
  --device-index=N --display-mode=NAME --keyer=MODE
  --stream-url=URL
  --vs-input-device=N --cam-file=PATH --bg-file=PATH --ndi-source=NAME
  --passthrough
  --cores=RANGE --dry-run --help
EOF
}

CH_ID=""
CH_NAME=""
OUTPUT_MODE="decklink"
DEVICE_INDEX=-1
DISPLAY_MODE="HD1080i50"
KEYER="fill_only"
STREAM_URL=""
VS_INPUT_DEVICE=-1
CAM_FILE=""
BG_FILE=""
NDI_SOURCE=""
PASSTHROUGH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --id=*) CH_ID="${1#*=}" ;;
    --name=*) CH_NAME="${1#*=}" ;;
    --output-mode=*) OUTPUT_MODE="${1#*=}" ;;
    --device-index=*) DEVICE_INDEX="${1#*=}" ;;
    --display-mode=*) DISPLAY_MODE="${1#*=}" ;;
    --keyer=*) KEYER="${1#*=}" ;;
    --stream-url=*) STREAM_URL="${1#*=}" ;;
    --vs-input-device=*) VS_INPUT_DEVICE="${1#*=}" ;;
    --cam-file=*) CAM_FILE="${1#*=}" ;;
    --bg-file=*) BG_FILE="${1#*=}" ;;
    --ndi-source=*) NDI_SOURCE="${1#*=}" ;;
    --passthrough) PASSTHROUGH=1 ;;
    --cores=*) CORES="${1#*=}" ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "run-vs-channel.sh: unknown option $1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

if [[ -z "$CH_ID" || -z "$CH_NAME" ]]; then
  echo "run-vs-channel.sh: --id and --name required" >&2
  exit 1
fi

if [[ ! -x "$VS_BIN" && "$DRY_RUN" != "1" ]]; then
  echo "run-vs-channel.sh: bg_vs_engine not found at $VS_BIN" >&2
  echo "  build: cd engine && cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build --target bg_vs_engine -j" >&2
  exit 1
fi

CONSUMER="null"
EXTRA_ARGS=()
case "$OUTPUT_MODE" in
  browser|obs_vmix) CONSUMER="null" ;;
  decklink)
    CONSUMER="decklink"
    EXTRA_ARGS+=(--device-index="$DEVICE_INDEX" --display-mode="$DISPLAY_MODE" --keyer="$KEYER")
    ;;
  stream)
    CONSUMER="stream"
    if [[ -z "$STREAM_URL" ]]; then
      echo "run-vs-channel.sh: stream requires --stream-url" >&2
      exit 1
    fi
    EXTRA_ARGS+=(--stream-url="$STREAM_URL")
    ;;
  *)
    echo "run-vs-channel.sh: unknown output_mode=$OUTPUT_MODE" >&2
    exit 1
    ;;
esac

CMD=("$VS_BIN"
  --name="$CH_NAME"
  --consumer="$CONSUMER"
  --vs-input-device="$VS_INPUT_DEVICE"
  --display-mode="$DISPLAY_MODE"
  --stats-interval=5
)
[[ -n "$CAM_FILE" ]] && CMD+=(--cam-file="$CAM_FILE")
[[ -n "$BG_FILE" ]] && CMD+=(--bg-file="$BG_FILE")
[[ -n "$NDI_SOURCE" ]] && CMD+=(--ndi-source="$NDI_SOURCE")
[[ "$PASSTHROUGH" == "1" ]] && CMD+=(--passthrough)
CMD+=("${EXTRA_ARGS[@]}")

if [[ -n "$CORES" ]]; then
  WRAP=(taskset -c "$CORES")
else
  WRAP=()
fi

echo "[run-vs-channel] ${CH_NAME} backend=unreal consumer=${CONSUMER} cam_in=${VS_INPUT_DEVICE}"
if [[ "$DRY_RUN" == "1" ]]; then
  echo "DRY-RUN: ${WRAP[*]} ${CMD[*]}"
  exit 0
fi

# Supervisor: exit 42 → 6s; other → 3s (same contract as run-channel.sh).
while true; do
  set +e
  "${WRAP[@]}" "${CMD[@]}"
  code=$?
  set -e
  if [[ $code -eq 42 ]]; then
    echo "[run-vs-channel] exit 42 (profile) — restart in 6s"
    sleep 6
  else
    echo "[run-vs-channel] exit ${code} — restart in 3s"
    sleep 3
  fi
done
