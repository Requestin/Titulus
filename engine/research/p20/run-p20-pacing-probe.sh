#!/usr/bin/env bash
# P20 semantic pacing probe. Safe by default: it writes only a manifest and
# prints the exact command. --execute is required to start any engine; a
# DeckLink run additionally requires --confirm-decklink.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CHANNEL=""
OUT_DIR=""
DURATION=60
CONSUMER="null"
DEVICE_INDEX=-1
BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:3001}"
ENGINE_BIN="${ENGINE_BIN:-${ROOT}/engine/build/Release/bg_engine}"
CORES=""
LAYERED="off"
EXECUTE=0
CONFIRM_DECKLINK=0
TEMPLATE="${ROOT}/tests/templates/p20-moving-bar.json"

usage() {
  cat <<'EOF'
Usage: run-p20-pacing-probe.sh --channel=UUID --out-dir=DIR [options]

Safe default: write manifest.json and print the planned command only.
Options:
  --duration=SEC             Probe duration, integer >= 30 (default 60)
  --consumer=null|decklink   null by default; DeckLink needs both flags below
  --device-index=N           Required only for --consumer=decklink
  --backend=URL              Backend channel.html origin
  --engine-bin=PATH          bg_engine path
  --cores=RANGE              Optional taskset CPU range
  --layered=off|on           Explicit research flag recorded in manifest
  --execute                  Permit a one-shot bg_engine launch
  --confirm-decklink         Required with --execute --consumer=decklink
  --help

The harness never uploads/takes the template. Before an executed run, an
operator must put tests/templates/p20-moving-bar.json on the selected channel.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --channel=*) CHANNEL="${arg#*=}" ;;
    --out-dir=*) OUT_DIR="${arg#*=}" ;;
    --duration=*) DURATION="${arg#*=}" ;;
    --consumer=*) CONSUMER="${arg#*=}" ;;
    --device-index=*) DEVICE_INDEX="${arg#*=}" ;;
    --backend=*) BACKEND_URL="${arg#*=}" ;;
    --engine-bin=*) ENGINE_BIN="${arg#*=}" ;;
    --cores=*) CORES="${arg#*=}" ;;
    --layered=*) LAYERED="${arg#*=}" ;;
    --execute) EXECUTE=1 ;;
    --confirm-decklink) CONFIRM_DECKLINK=1 ;;
    --help) usage; exit 0 ;;
    *) printf '[p20-probe] unknown option: %s\n' "$arg" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$CHANNEL" || -z "$OUT_DIR" ]]; then
  usage >&2
  exit 2
fi
if ! [[ "$DURATION" =~ ^[0-9]+$ ]] || (( DURATION < 30 )); then
  printf '[p20-probe] --duration must be an integer >= 30\n' >&2
  exit 2
fi
if [[ "$CONSUMER" != "null" && "$CONSUMER" != "decklink" ]]; then
  printf '[p20-probe] --consumer must be null|decklink\n' >&2
  exit 2
fi
if [[ "$LAYERED" != "off" && "$LAYERED" != "on" ]]; then
  printf '[p20-probe] --layered must be off|on\n' >&2
  exit 2
fi
if [[ "$CONSUMER" == "decklink" ]]; then
  if (( DEVICE_INDEX < 0 )); then
    printf '[p20-probe] DeckLink requires --device-index=N\n' >&2
    exit 2
  fi
  if (( EXECUTE == 1 && CONFIRM_DECKLINK != 1 )); then
    printf '[p20-probe] refusing DeckLink execution without --confirm-decklink\n' >&2
    exit 2
  fi
fi
if [[ ! -f "$TEMPLATE" ]]; then
  printf '[p20-probe] missing marker template: %s\n' "$TEMPLATE" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
RUN_DIR="$(cd "$OUT_DIR" && pwd)"
FRAME_LOG="${RUN_DIR}/frame.csv"
COMPLETION_LOG="${RUN_DIR}/decklink-completion.csv"
ENGINE_LOG="${RUN_DIR}/engine.log"
CACHE_DIR="${RUN_DIR}/cef-cache"
MANIFEST="${RUN_DIR}/manifest.json"
MARKER_GENERATOR="${ROOT}/engine/research/p20/generate-semantic-marker.mjs"

# Refuse a modified/generated-mismatch marker before any execution. This check
# is read-only and also keeps the manifest's decoder contract auditable.
node "$MARKER_GENERATOR" --check --out="$TEMPLATE"

CMD=(
  "$ENGINE_BIN"
  "--name=p20-pacing-probe"
  "--url=${BACKEND_URL}/channel.html?channel=${CHANNEL}&engine=1&engine_fps=50&w=1920&h=1080&pacing=1&graph=1"
  "--width=1920"
  "--height=1080"
  "--fps=50"
  "--duration=${DURATION}"
  "--consumer=${CONSUMER}"
  "--cache-dir=${CACHE_DIR}"
  "--frame-log=${FRAME_LOG}"
  "--decklink-completion-log=${COMPLETION_LOG}"
)
if [[ "$LAYERED" == "on" ]]; then CMD+=(--layered-compositor); fi
if [[ "$CONSUMER" == "decklink" ]]; then
  CMD+=(
    "--device-index=${DEVICE_INDEX}"
    "--display-mode=HD1080i50"
    "--keyer=fill_only"
  )
fi
if [[ -n "$CORES" ]]; then CMD=(taskset -c "$CORES" "${CMD[@]}"); fi

export P20_MANIFEST_PATH="$MANIFEST"
export P20_ROOT="$ROOT"
export P20_CHANNEL="$CHANNEL"
export P20_DURATION="$DURATION"
export P20_CONSUMER="$CONSUMER"
export P20_DEVICE_INDEX="$DEVICE_INDEX"
export P20_LAYERED="$LAYERED"
export P20_EXECUTION_MODE="$([[ "$EXECUTE" == 1 ]] && printf execute || printf dry_run)"
export P20_DECKLINK_ARMED="$([[ "$CONSUMER" == decklink && "$EXECUTE" == 1 ]] && printf true || printf false)"
export P20_TEMPLATE_SHA256="$(sha256sum "$TEMPLATE" | awk '{print $1}')"
export P20_ENGINE_SHA256="$(sha256sum "$ENGINE_BIN" 2>/dev/null | awk '{print $1}' || true)"
export P20_GIT_HEAD="$(git -C "$ROOT" rev-parse HEAD)"
export P20_KERNEL="$(uname -r)"
export P20_CREATED_UNIX_US="$(date -u +%s%6N)"
export P20_CMD_JSON="$(printf '%s\0' "${CMD[@]}" | node -e '
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    const values = Buffer.concat(chunks).toString("utf8").split("\0").filter(Boolean);
    process.stdout.write(JSON.stringify(values));
  });
')"

node - <<'NODE'
import { writeFileSync } from 'node:fs';

const root = process.env.P20_ROOT;
const manifest = {
  schemaVersion: 'p20-pacing-probe-v1',
  createdUnixUs: Number(process.env.P20_CREATED_UNIX_US),
  git: { head: process.env.P20_GIT_HEAD },
  host: { kernel: process.env.P20_KERNEL },
  template: {
    path: 'tests/templates/p20-moving-bar.json',
    sha256: process.env.P20_TEMPLATE_SHA256,
    takenByHarness: false,
  },
  requested: {
    channel: process.env.P20_CHANNEL,
    durationSeconds: Number(process.env.P20_DURATION),
    consumer: process.env.P20_CONSUMER,
    deviceIndex: Number(process.env.P20_DEVICE_INDEX),
    layered: process.env.P20_LAYERED,
  },
  execution: {
    mode: process.env.P20_EXECUTION_MODE,
    decklinkArmed: process.env.P20_DECKLINK_ARMED === 'true',
    hardwareAccess: process.env.P20_EXECUTION_MODE === 'execute'
      && process.env.P20_CONSUMER === 'decklink',
  },
  artifacts: {
    engineLog: 'engine.log',
    frameLog: 'frame.csv',
    completionLog: 'decklink-completion.csv',
    captureFields: 'capture-fields.csv',
    semanticAnalysis: 'semantic-analysis.json',
  },
  binaries: {
    engineSha256: process.env.P20_ENGINE_SHA256 || null,
    semanticAnalyzer: 'engine/research/p20/lib/analyze-semantic-fields.mjs',
    markerGenerator: 'engine/research/p20/generate-semantic-marker.mjs',
  },
  plannedCommand: JSON.parse(process.env.P20_CMD_JSON),
  notes: [
    'Manifest creation is not evidence that the marker template was taken on-air.',
    'DeckLink execution requires --execute and --confirm-decklink.',
    `Repository root: ${root}`,
  ],
};
writeFileSync(process.env.P20_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

printf '[p20-probe] manifest: %s\n' "$MANIFEST"
printf '[p20-probe] planned: '; printf '%q ' "${CMD[@]}"; printf '\n'
if (( EXECUTE == 0 )); then
  printf '[p20-probe] dry run only; pass --execute to start bg_engine\n'
  exit 0
fi

if [[ ! -x "$ENGINE_BIN" ]]; then
  printf '[p20-probe] bg_engine is not executable: %s\n' "$ENGINE_BIN" >&2
  exit 1
fi
if ps -eo comm= | awk '$1 == "bg_engine" { found = 1 } END { exit !found }'; then
  printf '[p20-probe] existing bg_engine process detected; stop it before a controlled probe\n' >&2
  exit 1
fi

mkdir -p "$CACHE_DIR"
P20_PID=""
cleanup() {
  if [[ -n "$P20_PID" ]] && kill -0 "$P20_PID" 2>/dev/null; then
    kill -TERM "$P20_PID" 2>/dev/null || true
    wait "$P20_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

printf '[p20-probe] executing one-shot engine; marker must already be taken on channel %s\n' "$CHANNEL"
"${CMD[@]}" >"$ENGINE_LOG" 2>&1 &
P20_PID=$!
wait "$P20_PID"
P20_PID=""
printf '[p20-probe] finished: %s\n' "$RUN_DIR"
