#!/usr/bin/env bash
# One reproducible P20 DeckLink cadence cell. Dry-run is the default.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MODE="${1:-}"
shift || true
CHANNELS=""
OUT_DIR=""
DURATION=60
WARMUP=60
BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:3003}"
ENGINE_BIN="${ENGINE_BIN:-${ROOT}/engine/build/Release/bg_engine}"
TEMPLATE="${ROOT}/tests/templates/p20-moving-bar.json"
RUNTIME_BUNDLE="${ROOT}/backend/public/bg-runtime.js"
TOKEN_FILE="${TOKEN_FILE:-/tmp/titulus-doc04-setup/token}"
LAYERED="off"
RASTER_THREADS=3
CPU_MASKS="0,6,1,7;2,8,3,9;4,10,5,11"
DEVICE_INDEXES="1,2,3"
START_OFFSETS_MS="0,0,0"
LABEL="canonical"
EXECUTE=0
CONFIRM_DECKLINK=0
LOCK="/tmp/titulus-p20-canonical.lock"

usage() {
  cat <<'EOF'
Usage: run-p20-cell.sh 1ch|3ch --channels=UUID[,UUID...] --out-dir=DIR [options]

Default mode is a no-hardware dry-run: it validates the exact cell and writes
root/chN manifests. Add --execute --confirm-decklink to launch the controlled
DeckLink cell (start -> reference lock -> take -> warmup -> measure -> cleanup).

Options:
  --duration=SEC             Measurement seconds (default 60)
  --warmup=SEC               Excluded warm-up seconds (default 60)
  --backend=URL              Backend origin (default http://127.0.0.1:3003)
  --engine-bin=PATH          bg_engine binary
  --template=PATH            P20 marker template
  --runtime-bundle=PATH      Built browser runtime bundle
  --token-file=PATH          Control WebSocket token for --execute
  --layered=off|on           Explicit compositor state (default off)
  --raster-threads=N         Explicit BG_NUM_RASTER_THREADS (default 3)
  --cpu-masks=A;B;C          Safe-mask permutation for the selected channels
  --device-indexes=A,B,C     Device-index permutation for selected channels
  --start-offsets-ms=A,B,C   Controlled spawn offsets (0/5/10 for matrix D)
  --label=NAME               Evidence label (does not affect config digest)
  --execute                  Permit hardware process launch and TAKE
  --confirm-decklink         Required together with --execute
EOF
}

fail() {
  printf '[p20-cell] %s\n' "$*" >&2
  exit 2
}

case "$MODE" in
  1ch|3ch) ;;
  -h|--help|"") usage; exit 2 ;;
  *) fail "mode must be 1ch|3ch" ;;
esac

for arg in "$@"; do
  case "$arg" in
    --channels=*) CHANNELS="${arg#*=}" ;;
    --out-dir=*) OUT_DIR="${arg#*=}" ;;
    --duration=*) DURATION="${arg#*=}" ;;
    --warmup=*) WARMUP="${arg#*=}" ;;
    --backend=*) BACKEND_URL="${arg#*=}" ;;
    --engine-bin=*) ENGINE_BIN="${arg#*=}" ;;
    --template=*) TEMPLATE="${arg#*=}" ;;
    --runtime-bundle=*) RUNTIME_BUNDLE="${arg#*=}" ;;
    --token-file=*) TOKEN_FILE="${arg#*=}" ;;
    --layered=*) LAYERED="${arg#*=}" ;;
    --raster-threads=*) RASTER_THREADS="${arg#*=}" ;;
    --cpu-masks=*) CPU_MASKS="${arg#*=}" ;;
    --device-indexes=*) DEVICE_INDEXES="${arg#*=}" ;;
    --start-offsets-ms=*) START_OFFSETS_MS="${arg#*=}" ;;
    --label=*) LABEL="${arg#*=}" ;;
    --execute) EXECUTE=1 ;;
    --confirm-decklink) CONFIRM_DECKLINK=1 ;;
    --help) usage; exit 0 ;;
    *) fail "unknown option: $arg" ;;
  esac
done

[[ -n "$CHANNELS" ]] || fail "--channels is required"
[[ -n "$OUT_DIR" ]] || fail "--out-dir is required"
[[ "$LAYERED" == "off" || "$LAYERED" == "on" ]] || fail "--layered must be off|on"
[[ "$DURATION" =~ ^[0-9]+$ && "$DURATION" -ge 30 ]] || fail "--duration must be an integer >= 30"
[[ "$WARMUP" =~ ^[0-9]+$ && "$WARMUP" -ge 10 ]] || fail "--warmup must be an integer >= 10"
[[ "$RASTER_THREADS" =~ ^[1-9][0-9]*$ ]] || fail "--raster-threads must be a positive integer"
if (( EXECUTE == 1 && CONFIRM_DECKLINK != 1 )); then
  fail "DeckLink execution requires --execute --confirm-decklink"
fi
[[ -f "$TEMPLATE" ]] || fail "missing template: $TEMPLATE"
[[ -f "$RUNTIME_BUNDLE" ]] || fail "missing runtime bundle: $RUNTIME_BUNDLE"
if (( EXECUTE == 1 )); then
  [[ -x "$ENGINE_BIN" ]] || fail "bg_engine is not executable: $ENGINE_BIN"
  [[ -s "$TOKEN_FILE" ]] || fail "missing token file: $TOKEN_FILE"
fi

IFS=',' read -r -a CHANNEL_ARRAY <<< "$CHANNELS"
IFS=';' read -r -a MASK_ARRAY <<< "$CPU_MASKS"
IFS=',' read -r -a DEVICE_ARRAY <<< "$DEVICE_INDEXES"
IFS=',' read -r -a OFFSET_ARRAY <<< "$START_OFFSETS_MS"
COUNT=1
[[ "$MODE" == "3ch" ]] && COUNT=3
(( ${#CHANNEL_ARRAY[@]} == COUNT )) || fail "$MODE requires exactly $COUNT channel ids"
(( ${#MASK_ARRAY[@]} == COUNT )) || fail "$MODE requires exactly $COUNT CPU masks"
(( ${#DEVICE_ARRAY[@]} == COUNT )) || fail "$MODE requires exactly $COUNT device indexes"
(( ${#OFFSET_ARRAY[@]} == COUNT )) || fail "$MODE requires exactly $COUNT start offsets"

SAFE_MASKS=("0,6,1,7" "2,8,3,9" "4,10,5,11")
SAFE_DEVICES=(1 2 3)
for index in "${!MASK_ARRAY[@]}"; do
  mask="${MASK_ARRAY[$index]}"
  offset="${OFFSET_ARRAY[$index]}"
  [[ "$offset" =~ ^[0-9]+$ ]] || fail "invalid start offset: $offset"
  if [[ ! " ${SAFE_MASKS[*]} " == *" ${mask} "* ]]; then
    fail "unsafe CPU mask outside canonical physical-safe set: $mask"
  fi
  if [[ ! " ${SAFE_DEVICES[*]} " == *" ${DEVICE_ARRAY[$index]} "* ]]; then
    fail "unsafe device index outside canonical set: ${DEVICE_ARRAY[$index]}"
  fi
  for previous in $(seq 0 $((index - 1))); do
    [[ "${MASK_ARRAY[$previous]}" != "$mask" ]] || fail "unsafe CPU mask overlap: $mask"
    [[ "${DEVICE_ARRAY[$previous]}" != "${DEVICE_ARRAY[$index]}" ]] || fail "duplicate device index: ${DEVICE_ARRAY[$index]}"
  done
done

mkdir -p "$OUT_DIR"
RUN_DIR="$(cd "$OUT_DIR" && pwd)"
for index in $(seq 1 "$COUNT"); do
  mkdir -p "$RUN_DIR/ch${index}/cef-cache"
done

MARKER_GENERATOR="${ROOT}/engine/research/p20/generate-semantic-marker.mjs"
node "$MARKER_GENERATOR" --check --out="$TEMPLATE"

BACKEND_HOST="${BACKEND_URL#http://}"
BACKEND_HOST="${BACKEND_HOST#https://}"
BACKEND_HOST="${BACKEND_HOST%%/*}"
GIT_HEAD="$(git -C "$ROOT" rev-parse HEAD)"
GIT_DIFF_SHA256="$(git -C "$ROOT" diff HEAD --binary | sha256sum | awk '{print $1}')"
ENGINE_SHA256="$(sha256sum "$ENGINE_BIN" 2>/dev/null | awk '{print $1}' || true)"
RUNTIME_SHA256="$(sha256sum "$RUNTIME_BUNDLE" | awk '{print $1}')"
TEMPLATE_SHA256="$(sha256sum "$TEMPLATE" | awk '{print $1}')"
LAYERED_VALUE=0
[[ "$LAYERED" == "on" ]] && LAYERED_VALUE=1
URL_PATTERN="http://${BACKEND_HOST}/channel.html?channel={channel}&engine=1&engine_fps=50&w=1920&h=1080&pacing=1&graph=1"

export P20_CONFIG_PATH="$RUN_DIR/config.json"
export P20_MODE="$MODE"
export P20_CHANNELS_JSON="$(printf '%s\n' "${CHANNEL_ARRAY[@]}" | node -e 'let a="";process.stdin.on("data",c=>a+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify(a.trim().split("\n"))))')"
export P20_MASKS_JSON="$(printf '%s\n' "${MASK_ARRAY[@]}" | node -e 'let a="";process.stdin.on("data",c=>a+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify(a.trim().split("\n"))))')"
export P20_DEVICES_JSON="$(printf '%s\n' "${DEVICE_ARRAY[@]}" | node -e 'let a="";process.stdin.on("data",c=>a+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify(a.trim().split("\n").map(Number))))')"
export P20_OFFSETS_JSON="$(printf '%s\n' "${OFFSET_ARRAY[@]}" | node -e 'let a="";process.stdin.on("data",c=>a+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify(a.trim().split("\n").map(Number))))')"
export P20_GIT_HEAD="$GIT_HEAD"
export P20_GIT_DIFF_SHA256="$GIT_DIFF_SHA256"
export P20_ENGINE_SHA256="$ENGINE_SHA256"
export P20_RUNTIME_SHA256="$RUNTIME_SHA256"
export P20_TEMPLATE_SHA256="$TEMPLATE_SHA256"
export P20_LAYERED_VALUE="$LAYERED_VALUE"
export P20_RASTER_THREADS="$RASTER_THREADS"
export P20_BACKEND_URL="$BACKEND_URL"
export P20_URL_PATTERN="$URL_PATTERN"
export P20_DURATION="$DURATION"
export P20_WARMUP="$WARMUP"
node - <<'NODE'
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const config = {
  schemaVersion: 'p20-canonical-config-v1',
  mode: process.env.P20_MODE,
  channels: JSON.parse(process.env.P20_CHANNELS_JSON),
  cpuMasks: JSON.parse(process.env.P20_MASKS_JSON),
  deviceIndexes: JSON.parse(process.env.P20_DEVICES_JSON),
  startOffsetsMs: JSON.parse(process.env.P20_OFFSETS_JSON),
  backendUrl: process.env.P20_BACKEND_URL,
  url: process.env.P20_URL_PATTERN,
  durationSeconds: Number(process.env.P20_DURATION),
  warmupSeconds: Number(process.env.P20_WARMUP),
  modeSettings: { displayMode: 'HD1080i50', keyer: 'fill_only', fps: 50 },
  environment: {
    BG_LAYERED_COMPOSITOR: process.env.P20_LAYERED_VALUE,
    BG_LAYERED_COMPOSITOR_ALLOWLIST: null,
    BG_NUM_RASTER_THREADS: process.env.P20_RASTER_THREADS,
  },
  git: { head: process.env.P20_GIT_HEAD, diffSha256: process.env.P20_GIT_DIFF_SHA256 },
  binaries: {
    engineSha256: process.env.P20_ENGINE_SHA256 || null,
    runtimeBundleSha256: process.env.P20_RUNTIME_SHA256,
  },
  template: { path: 'tests/templates/p20-moving-bar.json', sha256: process.env.P20_TEMPLATE_SHA256 },
};
const serialized = JSON.stringify(config);
const configDigest = createHash('sha256').update(serialized).digest('hex');
writeFileSync(process.env.P20_CONFIG_PATH, `${JSON.stringify({ config, configDigest }, null, 2)}\n`);
NODE

CONFIG_DIGEST="$(node -e 'console.log(require(process.argv[1]).configDigest)' "$RUN_DIR/config.json")"
EXECUTION_MODE="dry_run"
(( EXECUTE == 1 )) && EXECUTION_MODE="execute"
CREATED_UNIX_US="$(date -u +%s%6N)"
export P20_RUN_DIR="$RUN_DIR"
export P20_CONFIG_DIGEST="$CONFIG_DIGEST"
export P20_EXECUTION_MODE="$EXECUTION_MODE"
export P20_CREATED_UNIX_US="$CREATED_UNIX_US"
export P20_LABEL="$LABEL"
node - <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const { config, configDigest } = JSON.parse(readFileSync(`${process.env.P20_RUN_DIR}/config.json`, 'utf8'));
const root = {
  schemaVersion: 'p20-canonical-cell-v1',
  createdUnixUs: Number(process.env.P20_CREATED_UNIX_US),
  label: process.env.P20_LABEL,
  configDigest,
  config,
  execution: { mode: process.env.P20_EXECUTION_MODE, decklinkArmed: process.env.P20_EXECUTION_MODE === 'execute' },
  artifacts: { processSnapshot: 'processes-at-start.txt', cadenceAnalysis: 'cadence-analysis.json' },
};
writeFileSync(`${process.env.P20_RUN_DIR}/manifest.json`, `${JSON.stringify(root, null, 2)}\n`);
for (let index = 0; index < config.channels.length; index += 1) {
  const number = index + 1;
  const channel = {
    schemaVersion: 'p20-canonical-channel-v1',
    configDigest,
    execution: root.execution,
    channel: {
      index: number,
      id: config.channels[index],
      cpuMask: config.cpuMasks[index],
      deviceIndex: config.deviceIndexes[index],
      startOffsetMs: config.startOffsetsMs[index],
    },
    artifacts: {
      engineLog: 'engine.log',
      frameLog: 'frame.csv',
      completionLog: 'decklink-completion.csv',
      cefCache: 'cef-cache',
    },
  };
  writeFileSync(`${process.env.P20_RUN_DIR}/ch${number}/manifest.json`, `${JSON.stringify(channel, null, 2)}\n`);
}
NODE

for index in "${!CHANNEL_ARRAY[@]}"; do
  number=$((index + 1))
  channel="${CHANNEL_ARRAY[$index]}"
  channel_dir="$RUN_DIR/ch${number}"
  url="${URL_PATTERN/\{channel\}/$channel}"
  cmd=(
    "$ENGINE_BIN"
    "--name=p20-${LABEL}-ch${number}"
    "--url=${url}"
    "--width=1920" "--height=1080" "--fps=50" "--duration=0"
    "--consumer=decklink"
    "--device-index=${DEVICE_ARRAY[$index]}"
    "--display-mode=HD1080i50" "--keyer=fill_only"
    "--cache-dir=${channel_dir}/cef-cache"
    "--frame-log=${channel_dir}/frame.csv"
    "--decklink-completion-log=${channel_dir}/decklink-completion.csv"
  )
  (( LAYERED_VALUE == 1 )) && cmd+=(--layered-compositor)
  printf '%s\0' "${cmd[@]}" | node -e '
    let data = ""; process.stdin.on("data", c => { data += c; });
    process.stdin.on("end", () => {
      const command = data.split("\0").filter(Boolean);
      const path = process.argv[1];
      const fs = require("fs");
      const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
      manifest.plannedCommand = command;
      fs.writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    });
  ' "$channel_dir/manifest.json"
done

printf '[p20-cell] manifest: %s/manifest.json\n' "$RUN_DIR"
printf '[p20-cell] config digest: %s\n' "$CONFIG_DIGEST"
if (( EXECUTE == 0 )); then
  printf '[p20-cell] dry run only; use --execute --confirm-decklink to arm DeckLink\n'
  exit 0
fi

if [[ -e "$LOCK" ]]; then
  owner="$(<"$LOCK" 2>/dev/null || true)"
  [[ "$owner" =~ ^[0-9]+$ ]] && kill -0 "$owner" 2>/dev/null && fail "another canonical run owns $LOCK (pid=$owner)"
  rm -f "$LOCK"
fi
if pgrep -f "${ROOT}/engine/(build/Release/bg_engine|run-channel.sh)" >/dev/null; then
  pgrep -af "${ROOT}/engine/(build/Release/bg_engine|run-channel.sh)" >&2 || true
  fail "pre-existing Titulus engine process detected"
fi

printf '%s\n' "$$" >"$LOCK"
PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do kill -TERM -- "-$pid" 2>/dev/null || true; done
  for pid in "${PIDS[@]:-}"; do wait "$pid" 2>/dev/null || true; done
  [[ "$(<"$LOCK" 2>/dev/null || true)" == "$$" ]] && rm -f "$LOCK"
}
trap cleanup EXIT INT TERM
ps -eo pid=,ppid=,pgid=,comm=,args= >"$RUN_DIR/processes-at-start.txt"

for index in "${!CHANNEL_ARRAY[@]}"; do
  number=$((index + 1))
  channel="${CHANNEL_ARRAY[$index]}"
  channel_dir="$RUN_DIR/ch${number}"
  url="${URL_PATTERN/\{channel\}/$channel}"
  (( OFFSET_ARRAY[index] > 0 )) && sleep "$(awk "BEGIN { print ${OFFSET_ARRAY[index]} / 1000 }")"
  cmd=(
    "$ENGINE_BIN"
    "--name=p20-${LABEL}-ch${number}"
    "--url=${url}"
    "--width=1920" "--height=1080" "--fps=50" "--duration=0"
    "--consumer=decklink"
    "--device-index=${DEVICE_ARRAY[$index]}"
    "--display-mode=HD1080i50" "--keyer=fill_only"
    "--cache-dir=${channel_dir}/cef-cache"
    "--frame-log=${channel_dir}/frame.csv"
    "--decklink-completion-log=${channel_dir}/decklink-completion.csv"
  )
  (( LAYERED_VALUE == 1 )) && cmd+=(--layered-compositor)
  setsid env -u BG_LAYERED_COMPOSITOR -u BG_LAYERED_COMPOSITOR_ALLOWLIST -u BG_NUM_RASTER_THREADS \
    "BG_LAYERED_COMPOSITOR=${LAYERED_VALUE}" "BG_NUM_RASTER_THREADS=${RASTER_THREADS}" \
    taskset -c "${MASK_ARRAY[$index]}" "${cmd[@]}" >"$channel_dir/engine.log" 2>&1 &
  PIDS+=("$!")
done

for _ in $(seq 1 120); do
  ready=0
  for number in $(seq 1 "$COUNT"); do
    log="$RUN_DIR/ch${number}/engine.log"
    if grep -q 'started mode=HD1080i50.*low_latency=yes' "$log" \
      && grep -q 'reference signal locked' "$log"; then
      ready=$((ready + 1))
    fi
  done
  (( ready == COUNT )) && break
  sleep 1
done
(( ready == COUNT )) || fail "not all channels reached started+reference locked"

TOKEN="$(<"$TOKEN_FILE")"
for index in "${!CHANNEL_ARRAY[@]}"; do
  node "$ROOT/backend/p15-take.mjs" "${CHANNEL_ARRAY[$index]}" "$TEMPLATE" "$TOKEN" \
    >>"$RUN_DIR/takes.log" 2>&1
done
sleep "$WARMUP"
MEASURE_START_UNIX_US="$(date -u +%s%6N)"
sleep "$DURATION"
MEASURE_END_UNIX_US="$(date -u +%s%6N)"
ps -eo pid=,ppid=,pgid=,comm=,args= >"$RUN_DIR/processes-at-stop.txt"
export P20_MEASURE_START_UNIX_US="$MEASURE_START_UNIX_US"
export P20_MEASURE_END_UNIX_US="$MEASURE_END_UNIX_US"
node - <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const path = `${process.env.P20_RUN_DIR}/manifest.json`;
const manifest = JSON.parse(readFileSync(path, 'utf8'));
manifest.measurement = {
  warmupSeconds: manifest.config.warmupSeconds,
  startUnixUs: Number(process.env.P20_MEASURE_START_UNIX_US),
  endUnixUs: Number(process.env.P20_MEASURE_END_UNIX_US),
};
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
printf '[p20-cell] completed: %s\n' "$RUN_DIR"
