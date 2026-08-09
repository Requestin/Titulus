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
CONSUMER="decklink"
LAYERED="off"
RASTER_THREADS=3
PACING_MODE="accumulator"
PROVENANCE="on"
TOKEN_ARMED_WAIT=0
ABSOLUTE_FIELD_GRID=0
ONE_PAIR_RESERVOIR=0
LOOPBACK_CAPTURE_BIN=""
LOOPBACK_INPUT_DEVICE=""
LOOPBACK_OUTPUT_CHANNEL=""
LOOPBACK_CAPTURE_INPUT=""
CPU_MASKS="0,6,1,7;2,8,3,9;4,10,5,11"
DEVICE_INDEXES="1,2,3"
START_OFFSETS_MS="0,0,0"
CPU_MASKS_EXPLICIT=0
DEVICE_INDEXES_EXPLICIT=0
START_OFFSETS_EXPLICIT=0
LABEL="canonical"
EXECUTE=0
CONFIRM_DECKLINK=0
LOCK="/tmp/titulus-p20-canonical.lock"

usage() {
  cat <<'EOF'
Usage: run-p20-cell.sh 1ch|3ch --channels=UUID[,UUID...] --out-dir=DIR [options]

Default mode is a dry-run: it validates the exact cell and writes root/chN
manifests. DeckLink execution requires --execute --confirm-decklink; null
execution needs only --execute.

Options:
  --duration=SEC             Measurement seconds (default 60)
  --warmup=SEC               Excluded warm-up seconds (default 60)
  --backend=URL              Backend origin (default http://127.0.0.1:3003)
  --engine-bin=PATH          bg_engine binary
  --template=PATH            P20 marker template
  --runtime-bundle=PATH      Built browser runtime bundle
  --token-file=PATH          Control WebSocket token for --execute
  --consumer=decklink|null   Render consumer (default decklink)
  --layered=off|on           Explicit compositor state (default off)
  --raster-threads=N         Explicit BG_NUM_RASTER_THREADS (default 3)
  --pacing-mode=MODE         accumulator|one-tick (default accumulator)
  --provenance=on|off        P20 runtime + DeckLink event logs (default on)
  --token-armed-wait         Complete waits only on post-send CEF paint
  --absolute-field-grid      Place DeckLink batch requests on 20-ms field targets
  --one-pair-reservoir       Boundedly wait for one complete interlaced pair
  --loopback-capture-bin=PATH  Observer capture binary (1ch only)
  --loopback-input-device=N    DeckLink input device for observer capture
  --loopback-output-channel=T  Safe output label recorded in capture CSV
  --loopback-capture-input=T   Safe physical input label recorded in capture CSV
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
    --consumer=*) CONSUMER="${arg#*=}" ;;
    --layered=*) LAYERED="${arg#*=}" ;;
    --raster-threads=*) RASTER_THREADS="${arg#*=}" ;;
    --pacing-mode=*) PACING_MODE="${arg#*=}" ;;
    --provenance=*) PROVENANCE="${arg#*=}" ;;
    --token-armed-wait) TOKEN_ARMED_WAIT=1 ;;
    --absolute-field-grid) ABSOLUTE_FIELD_GRID=1 ;;
    --one-pair-reservoir) ONE_PAIR_RESERVOIR=1 ;;
    --loopback-capture-bin=*) LOOPBACK_CAPTURE_BIN="${arg#*=}" ;;
    --loopback-input-device=*) LOOPBACK_INPUT_DEVICE="${arg#*=}" ;;
    --loopback-output-channel=*) LOOPBACK_OUTPUT_CHANNEL="${arg#*=}" ;;
    --loopback-capture-input=*) LOOPBACK_CAPTURE_INPUT="${arg#*=}" ;;
    --cpu-masks=*) CPU_MASKS="${arg#*=}"; CPU_MASKS_EXPLICIT=1 ;;
    --device-indexes=*) DEVICE_INDEXES="${arg#*=}"; DEVICE_INDEXES_EXPLICIT=1 ;;
    --start-offsets-ms=*) START_OFFSETS_MS="${arg#*=}"; START_OFFSETS_EXPLICIT=1 ;;
    --label=*) LABEL="${arg#*=}" ;;
    --execute) EXECUTE=1 ;;
    --confirm-decklink) CONFIRM_DECKLINK=1 ;;
    --help) usage; exit 0 ;;
    *) fail "unknown option: $arg" ;;
  esac
done

[[ -n "$CHANNELS" ]] || fail "--channels is required"
[[ -n "$OUT_DIR" ]] || fail "--out-dir is required"
[[ "$CONSUMER" == "decklink" || "$CONSUMER" == "null" ]] \
  || fail "--consumer must be decklink|null"
[[ "$LAYERED" == "off" || "$LAYERED" == "on" ]] || fail "--layered must be off|on"
case "$PACING_MODE" in
  accumulator) PACING_MODE="accumulator" ;;
  one-tick) PACING_MODE="one_tick" ;;
  *) fail "--pacing-mode must be accumulator|one-tick" ;;
esac
[[ "$PROVENANCE" == "on" || "$PROVENANCE" == "off" ]] || fail "--provenance must be on|off"
if (( ABSOLUTE_FIELD_GRID == 1 && TOKEN_ARMED_WAIT != 1 )); then
  fail "--absolute-field-grid requires --token-armed-wait for the P20 one-factor A/B"
fi
if (( ONE_PAIR_RESERVOIR == 1 && TOKEN_ARMED_WAIT != 1 )); then
  fail "--one-pair-reservoir requires --token-armed-wait for the P20 one-factor A/B"
fi
if (( ABSOLUTE_FIELD_GRID == 1 && ONE_PAIR_RESERVOIR == 1 )); then
  fail "--absolute-field-grid and --one-pair-reservoir cannot be combined"
fi
if [[ "$CONSUMER" != "decklink" ]] \
  && (( TOKEN_ARMED_WAIT == 1 || ABSOLUTE_FIELD_GRID == 1 || ONE_PAIR_RESERVOIR == 1 )); then
  fail "DeckLink pacing flags require --consumer=decklink"
fi
[[ "$DURATION" =~ ^[0-9]+$ && "$DURATION" -ge 30 ]] || fail "--duration must be an integer >= 30"
[[ "$WARMUP" =~ ^[0-9]+$ && "$WARMUP" -ge 10 ]] || fail "--warmup must be an integer >= 10"
[[ "$RASTER_THREADS" =~ ^[1-9][0-9]*$ ]] || fail "--raster-threads must be a positive integer"
LOOPBACK_ENABLED=0
if [[ -n "$LOOPBACK_CAPTURE_BIN$LOOPBACK_INPUT_DEVICE$LOOPBACK_OUTPUT_CHANNEL$LOOPBACK_CAPTURE_INPUT" ]]; then
  [[ -n "$LOOPBACK_CAPTURE_BIN" && -n "$LOOPBACK_INPUT_DEVICE" \
    && -n "$LOOPBACK_OUTPUT_CHANNEL" && -n "$LOOPBACK_CAPTURE_INPUT" ]] \
    || fail "all loopback capture options must be supplied together"
  [[ "$LOOPBACK_INPUT_DEVICE" =~ ^[0-9]+$ ]] || fail "--loopback-input-device must be non-negative"
  [[ "$MODE" == "1ch" ]] || fail "integrated loopback capture currently requires 1ch mode"
  [[ "$CONSUMER" == "decklink" ]] || fail "integrated loopback capture requires --consumer=decklink"
  LOOPBACK_ENABLED=1
fi
ENGINE_DURATION=$((WARMUP + DURATION + 60))
if (( EXECUTE == 1 )) && [[ "$CONSUMER" == "decklink" ]] && (( CONFIRM_DECKLINK != 1 )); then
  fail "DeckLink execution requires --execute --confirm-decklink"
fi
[[ -f "$TEMPLATE" ]] || fail "missing template: $TEMPLATE"
[[ -f "$RUNTIME_BUNDLE" ]] || fail "missing runtime bundle: $RUNTIME_BUNDLE"
if (( EXECUTE == 1 )); then
  [[ -x "$ENGINE_BIN" ]] || fail "bg_engine is not executable: $ENGINE_BIN"
  [[ -s "$TOKEN_FILE" ]] || fail "missing token file: $TOKEN_FILE"
  (( LOOPBACK_ENABLED == 0 )) || [[ -x "$LOOPBACK_CAPTURE_BIN" ]] \
    || fail "loopback capture binary is not executable: $LOOPBACK_CAPTURE_BIN"
fi

COUNT=1
[[ "$MODE" == "3ch" ]] && COUNT=3
if (( COUNT == 1 )); then
  (( CPU_MASKS_EXPLICIT == 1 )) || CPU_MASKS="${CPU_MASKS%%;*}"
  (( DEVICE_INDEXES_EXPLICIT == 1 )) || DEVICE_INDEXES="${DEVICE_INDEXES%%,*}"
  (( START_OFFSETS_EXPLICIT == 1 )) || START_OFFSETS_MS="${START_OFFSETS_MS%%,*}"
fi
IFS=',' read -r -a CHANNEL_ARRAY <<< "$CHANNELS"
IFS=';' read -r -a MASK_ARRAY <<< "$CPU_MASKS"
IFS=',' read -r -a DEVICE_ARRAY <<< "$DEVICE_INDEXES"
IFS=',' read -r -a OFFSET_ARRAY <<< "$START_OFFSETS_MS"
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

if [[ -e "$OUT_DIR" ]]; then
  [[ -d "$OUT_DIR" ]] || fail "--out-dir exists and is not a directory"
  [[ -z "$(ls -A -- "$OUT_DIR")" ]] || fail "output directory must be empty; refusing to reuse artifacts"
else
  mkdir -p "$OUT_DIR"
fi
RUN_DIR="$(cd "$OUT_DIR" && pwd)"
for index in $(seq 1 "$COUNT"); do
  mkdir -p "$RUN_DIR/ch${index}/cef-cache"
done

MARKER_GENERATOR="${ROOT}/engine/research/p20/generate-semantic-marker.mjs"
TEST1_MARKER_GENERATOR="${ROOT}/engine/research/p20/generate-test1-marker.mjs"
case "$TEMPLATE" in
  */p20-moving-bar.json) node "$MARKER_GENERATOR" --check --out="$TEMPLATE" ;;
  */p20-test1-marker.json) node "$TEST1_MARKER_GENERATOR" --check --out="$TEMPLATE" ;;
esac

BACKEND_HOST="${BACKEND_URL#http://}"
BACKEND_HOST="${BACKEND_HOST#https://}"
BACKEND_HOST="${BACKEND_HOST%%/*}"
GIT_HEAD="$(git -C "$ROOT" rev-parse HEAD)"
GIT_DIFF_SHA256="$(git -C "$ROOT" diff HEAD --binary | sha256sum | awk '{print $1}')"
ENGINE_SHA256="$(sha256sum "$ENGINE_BIN" 2>/dev/null | awk '{print $1}' || true)"
RUNTIME_SHA256="$(sha256sum "$RUNTIME_BUNDLE" | awk '{print $1}')"
TEMPLATE_SHA256="$(sha256sum "$TEMPLATE" | awk '{print $1}')"
TEMPLATE_PATH="$(realpath --relative-to="$ROOT" "$TEMPLATE")"
LAYERED_VALUE=0
[[ "$LAYERED" == "on" ]] && LAYERED_VALUE=1
PACING_QUERY=0
[[ "$PROVENANCE" == "on" ]] && PACING_QUERY=1
URL_PATTERN="http://${BACKEND_HOST}/channel.html?channel={channel}&engine=1&engine_fps=50&w=1920&h=1080&pacing=${PACING_QUERY}&graph=1&pacing_mode=${PACING_MODE}"

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
export P20_TEMPLATE_PATH="$TEMPLATE_PATH"
export P20_CONSUMER="$CONSUMER"
export P20_LAYERED_VALUE="$LAYERED_VALUE"
export P20_RASTER_THREADS="$RASTER_THREADS"
export P20_PACING_MODE="$PACING_MODE"
export P20_PROVENANCE="$PROVENANCE"
export P20_TOKEN_ARMED_WAIT="$TOKEN_ARMED_WAIT"
export P20_ABSOLUTE_FIELD_GRID="$ABSOLUTE_FIELD_GRID"
export P20_ONE_PAIR_RESERVOIR="$ONE_PAIR_RESERVOIR"
export P20_LOOPBACK_ENABLED="$LOOPBACK_ENABLED"
export P20_LOOPBACK_INPUT_DEVICE="$LOOPBACK_INPUT_DEVICE"
export P20_LOOPBACK_OUTPUT_CHANNEL="$LOOPBACK_OUTPUT_CHANNEL"
export P20_LOOPBACK_CAPTURE_INPUT="$LOOPBACK_CAPTURE_INPUT"
export P20_BACKEND_URL="$BACKEND_URL"
export P20_URL_PATTERN="$URL_PATTERN"
export P20_DURATION="$DURATION"
export P20_WARMUP="$WARMUP"
export P20_ENGINE_DURATION="$ENGINE_DURATION"
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
  engineDurationSeconds: Number(process.env.P20_ENGINE_DURATION),
  consumer: process.env.P20_CONSUMER,
  modeSettings: process.env.P20_CONSUMER === 'decklink'
    ? { displayMode: 'HD1080i50', keyer: 'fill_only', fps: 50 }
    : { fps: 50 },
  pacingMode: process.env.P20_PACING_MODE,
  provenance: process.env.P20_PROVENANCE,
  tokenArmedWait: process.env.P20_TOKEN_ARMED_WAIT === '1',
  absoluteFieldGrid: process.env.P20_ABSOLUTE_FIELD_GRID === '1',
  onePairReservoir: process.env.P20_ONE_PAIR_RESERVOIR === '1',
  loopback: process.env.P20_LOOPBACK_ENABLED === '1' ? {
    inputDeviceIndex: Number(process.env.P20_LOOPBACK_INPUT_DEVICE),
    outputChannel: process.env.P20_LOOPBACK_OUTPUT_CHANNEL,
    captureInput: process.env.P20_LOOPBACK_CAPTURE_INPUT,
  } : null,
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
  template: { path: process.env.P20_TEMPLATE_PATH, sha256: process.env.P20_TEMPLATE_SHA256 },
};
const serialized = JSON.stringify(config);
const configDigest = createHash('sha256').update(serialized).digest('hex');
writeFileSync(process.env.P20_CONFIG_PATH, `${JSON.stringify({ config, configDigest }, null, 2)}\n`);
NODE

CONFIG_DIGEST="$(node -e 'console.log(require(process.argv[1]).configDigest)' "$RUN_DIR/config.json")"
EXECUTION_MODE="dry_run"
(( EXECUTE == 1 )) && EXECUTION_MODE="execute"
CREATED_UNIX_US="$(date -u +%s%6N)"
RUN_ID="${CREATED_UNIX_US}-${CONFIG_DIGEST:0:12}"
export P20_RUN_DIR="$RUN_DIR"
export P20_CONFIG_DIGEST="$CONFIG_DIGEST"
export P20_EXECUTION_MODE="$EXECUTION_MODE"
export P20_CREATED_UNIX_US="$CREATED_UNIX_US"
export P20_RUN_ID="$RUN_ID"
export P20_LABEL="$LABEL"
node - <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const { config, configDigest } = JSON.parse(readFileSync(`${process.env.P20_RUN_DIR}/config.json`, 'utf8'));
const root = {
  schemaVersion: 'p20-canonical-cell-v1',
  runId: process.env.P20_RUN_ID,
  createdUnixUs: Number(process.env.P20_CREATED_UNIX_US),
  label: process.env.P20_LABEL,
  configDigest,
  config,
  execution: {
    mode: process.env.P20_EXECUTION_MODE,
    decklinkArmed: process.env.P20_EXECUTION_MODE === 'execute'
      && config.consumer === 'decklink',
  },
      artifacts: {
        processSnapshot: 'processes-at-start.txt',
        cadenceAnalysis: 'cadence-analysis.json',
        captureFields: config.loopback ? 'capture-fields.csv' : null,
        captureSummary: config.loopback ? 'capture-summary.json' : null,
        jointEvidence: config.loopback ? 'joint-evidence.json' : null,
      },
};
writeFileSync(`${process.env.P20_RUN_DIR}/manifest.json`, `${JSON.stringify(root, null, 2)}\n`);
for (let index = 0; index < config.channels.length; index += 1) {
  const number = index + 1;
  const channel = {
    schemaVersion: 'p20-canonical-channel-v1',
      runId: process.env.P20_RUN_ID,
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
      completionLog: config.provenance === 'on' && config.consumer === 'decklink'
        ? 'decklink-completion.csv' : null,
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
    "--width=1920" "--height=1080" "--fps=50" "--duration=${ENGINE_DURATION}"
    "--consumer=${CONSUMER}"
    "--cache-dir=${channel_dir}/cef-cache"
    "--frame-log=${channel_dir}/frame.csv"
  )
  if [[ "$CONSUMER" == "decklink" ]]; then
    cmd+=(
      "--device-index=${DEVICE_ARRAY[$index]}"
      "--display-mode=HD1080i50" "--keyer=fill_only"
    )
    [[ "$PROVENANCE" == "on" ]] && cmd+=("--decklink-completion-log=${channel_dir}/decklink-completion.csv")
  fi
  (( LAYERED_VALUE == 1 )) && cmd+=(--layered-compositor)
  (( TOKEN_ARMED_WAIT == 1 )) && cmd+=(--decklink-token-armed-wait)
  (( ABSOLUTE_FIELD_GRID == 1 )) && cmd+=(--decklink-absolute-field-grid)
  (( ONE_PAIR_RESERVOIR == 1 )) && cmd+=(--decklink-one-pair-reservoir)
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

if (( LOOPBACK_ENABLED == 1 )); then
  capture_cmd=(
    "$LOOPBACK_CAPTURE_BIN"
    "--device-index=${LOOPBACK_INPUT_DEVICE}"
    "--duration-sec=${DURATION}"
    "--field-order=tff"
    "--output-channel=${LOOPBACK_OUTPUT_CHANNEL}"
    "--capture-input=${LOOPBACK_CAPTURE_INPUT}"
    "--run-id=${RUN_ID}"
    "--config-digest=${CONFIG_DIGEST}"
    "--summary=${RUN_DIR}/capture-summary.json"
    "--csv=${RUN_DIR}/capture-fields.csv"
  )
  printf '%s\0' "${capture_cmd[@]}" | node -e '
    let data = ""; process.stdin.on("data", c => { data += c; });
    process.stdin.on("end", () => {
      const path = process.argv[1];
      const fs = require("fs");
      const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
      manifest.plannedCaptureCommand = data.split("\0").filter(Boolean);
      fs.writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    });
  ' "$RUN_DIR/manifest.json"
fi

printf '[p20-cell] manifest: %s/manifest.json\n' "$RUN_DIR"
printf '[p20-cell] config digest: %s\n' "$CONFIG_DIGEST"
if (( EXECUTE == 0 )); then
  printf '[p20-cell] dry run only; use --execute --confirm-decklink to arm DeckLink\n'
  exit 0
fi

exec {LOCK_FD}>"$LOCK"
flock -n "$LOCK_FD" || fail "another canonical run owns $LOCK"
if pgrep -f "${ROOT}/engine/(build/Release/bg_engine|run-channel.sh)" >/dev/null; then
  pgrep -af "${ROOT}/engine/(build/Release/bg_engine|run-channel.sh)" >&2 || true
  fail "pre-existing Titulus engine process detected"
fi

printf '%s\n' "$$" >&"$LOCK_FD"
PIDS=()
RUN_COMPLETED=0

write_run_status() {
  local outcome="$1"
  local reason="$2"
  P20_RUN_OUTCOME="$outcome" P20_RUN_REASON="$reason" P20_RUN_STATUS_PATH="$RUN_DIR/run-status.json" \
  P20_RUN_ID="$RUN_ID" P20_CONFIG_DIGEST="$CONFIG_DIGEST" \
  P20_STATUS_START="${MEASURE_START_UNIX_US:-0}" P20_STATUS_END="${MEASURE_END_UNIX_US:-0}" \
    node - <<'NODE'
import { renameSync, writeFileSync } from 'node:fs';
const path = process.env.P20_RUN_STATUS_PATH;
const temporary = `${path}.${process.pid}.tmp`;
writeFileSync(temporary, `${JSON.stringify({
  schemaVersion: 'p20-run-status-v1',
  runId: process.env.P20_RUN_ID,
  configDigest: process.env.P20_CONFIG_DIGEST,
  outcome: process.env.P20_RUN_OUTCOME,
  reason: process.env.P20_RUN_REASON,
  measurement: {
    startUnixUs: Number(process.env.P20_STATUS_START),
    endUnixUs: Number(process.env.P20_STATUS_END),
  },
}, null, 2)}\n`);
renameSync(temporary, path);
NODE
}

cleanup() {
  local exit_status=$?
  local pid
  set +e
  for pid in "${PIDS[@]:-}"; do
    kill -TERM -- "-$pid" 2>/dev/null || true
  done
  for _ in $(seq 1 40); do
    local alive=0
    for pid in "${PIDS[@]:-}"; do
      pgrep -g "$pid" >/dev/null 2>&1 && alive=1
    done
    (( alive == 0 )) && break
    sleep 0.25
  done
  for pid in "${PIDS[@]:-}"; do
    if pgrep -g "$pid" >/dev/null 2>&1; then
      kill -KILL -- "-$pid" 2>/dev/null || true
    fi
  done
  for pid in "${PIDS[@]:-}"; do wait "$pid" 2>/dev/null || true; done
  for pid in "${PIDS[@]:-}"; do
    if pgrep -g "$pid" >/dev/null 2>&1; then
      printf '[p20-cell] remaining CEF/engine process group pgid=%s after KILL\n' "$pid" >&2
      exit_status=1
    fi
  done
  if (( RUN_COMPLETED == 0 )); then
    write_run_status "aborted" "exit_status=${exit_status}"
  fi
  return "$exit_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
write_run_status "running" "engines starting"
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
    "--width=1920" "--height=1080" "--fps=50" "--duration=${ENGINE_DURATION}"
    "--consumer=${CONSUMER}"
    "--cache-dir=${channel_dir}/cef-cache"
    "--frame-log=${channel_dir}/frame.csv"
  )
  if [[ "$CONSUMER" == "decklink" ]]; then
    cmd+=(
      "--device-index=${DEVICE_ARRAY[$index]}"
      "--display-mode=HD1080i50" "--keyer=fill_only"
    )
    [[ "$PROVENANCE" == "on" ]] && cmd+=("--decklink-completion-log=${channel_dir}/decklink-completion.csv")
  fi
  (( LAYERED_VALUE == 1 )) && cmd+=(--layered-compositor)
  (( TOKEN_ARMED_WAIT == 1 )) && cmd+=(--decklink-token-armed-wait)
  (( ABSOLUTE_FIELD_GRID == 1 )) && cmd+=(--decklink-absolute-field-grid)
  (( ONE_PAIR_RESERVOIR == 1 )) && cmd+=(--decklink-one-pair-reservoir)
  setsid env -u BG_LAYERED_COMPOSITOR -u BG_LAYERED_COMPOSITOR_ALLOWLIST -u BG_NUM_RASTER_THREADS \
    "BG_LAYERED_COMPOSITOR=${LAYERED_VALUE}" "BG_NUM_RASTER_THREADS=${RASTER_THREADS}" \
    taskset -c "${MASK_ARRAY[$index]}" "${cmd[@]}" >"$channel_dir/engine.log" 2>&1 &
  PIDS+=("$!")
done

for _ in $(seq 1 120); do
  ready=0
  for number in $(seq 1 "$COUNT"); do
    log="$RUN_DIR/ch${number}/engine.log"
    if [[ "$CONSUMER" == "decklink" ]] \
      && grep -q 'started mode=HD1080i50.*low_latency=yes' "$log" \
      && grep -q 'reference signal locked' "$log"; then
      ready=$((ready + 1))
    elif [[ "$CONSUMER" == "null" ]] && grep -q 'browser created, loading' "$log"; then
      ready=$((ready + 1))
    fi
  done
  (( ready == COUNT )) && break
  sleep 1
done
(( ready == COUNT )) || fail "not all channels reached consumer readiness"

TOKEN="$(<"$TOKEN_FILE")"
for index in "${!CHANNEL_ARRAY[@]}"; do
  node "$ROOT/backend/p20-take.mjs" "${CHANNEL_ARRAY[$index]}" "$TEMPLATE" "$TOKEN" \
    >>"$RUN_DIR/takes.log" 2>&1
done
sleep "$WARMUP"
if (( LOOPBACK_ENABLED == 1 )); then
  setsid "${capture_cmd[@]}" >"$RUN_DIR/capture.log" 2>&1 &
  PIDS+=("$!")
  capture_pid="$!"
  capture_ready=0
  for _ in $(seq 1 100); do
    grep -q '\[p20-field-capture\] capturing ' "$RUN_DIR/capture.log" && {
      capture_ready=1
      break
    }
    kill -0 "$capture_pid" 2>/dev/null || fail "loopback capture exited before readiness"
    sleep 0.1
  done
  (( capture_ready == 1 )) || fail "loopback capture readiness timeout"
fi
MEASURE_START_UNIX_US="$(date -u +%s%6N)"
sleep "$DURATION"
MEASURE_END_UNIX_US="$(date -u +%s%6N)"
# The engine's own duration exits through its normal teardown, flushing the
# FrameLog and DeckLinkEventLog. A process-group TERM is a timeout fallback
# only; it cannot serve as M0 evidence because it can truncate both CSVs.
GRACE_DEADLINE=$((SECONDS + 90))
while true; do
  alive=0
  for pid in "${PIDS[@]}"; do
    kill -0 "$pid" 2>/dev/null && alive=1
  done
  (( alive == 0 )) && break
  (( SECONDS < GRACE_DEADLINE )) || fail "engine duration did not exit gracefully"
  sleep 1
done
status=0
for pid in "${PIDS[@]}"; do
  wait "$pid" || status=1
done
(( status == 0 )) || fail "one or more engines failed before graceful completion"
for pid in "${PIDS[@]}"; do
  if pgrep -g "$pid" >/dev/null 2>&1; then
    fail "remaining CEF/engine process group pgid=$pid after graceful engine exit"
  fi
done
PIDS=()
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
for number in $(seq 1 "$COUNT"); do
  if rg --fixed-strings --quiet \
      --regexp='bg_engine[cef]: renderer_terminated' \
      "$RUN_DIR/ch${number}/engine.log"; then
    RUN_COMPLETED=1
    write_run_status "failed" "CEF renderer terminated"
    fail "CEF renderer terminated in ch${number}; evidence is inconclusive"
  fi
done
write_run_status "completed" "graceful"
if (( LOOPBACK_ENABLED == 1 )); then
  node "$ROOT/engine/research/p20/lib/analyze-p20-evidence.mjs" \
    --run-dir="$RUN_DIR" \
    --capture="$RUN_DIR/capture-fields.csv" \
    --capture-summary="$RUN_DIR/capture-summary.json" \
    --channel=1 \
    --output-channel="$LOOPBACK_OUTPUT_CHANNEL" \
    --capture-input="$LOOPBACK_CAPTURE_INPUT" \
    --out="$RUN_DIR/joint-evidence.json"
fi
RUN_COMPLETED=1
printf '[p20-cell] completed: %s\n' "$RUN_DIR"
