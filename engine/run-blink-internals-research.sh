#!/usr/bin/env bash
# engine/run-blink-internals-research.sh — Phase 12b bench + trace orchestrator.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE="${ENGINE_BIN:-${ROOT}/engine/build/Release/bg_engine}"
OUT="${OUT_DIR:-/tmp/titulus-blink-internals}"
DUR="${DURATION:-20}"
FPS=50

mkdir -p "$OUT"

log() { echo "[blink-internals] $*"; }

if [[ ! -x "$ENGINE" ]]; then
  log "Building engine…"
  cmake --build "${ROOT}/engine/build" -j"$(nproc)"
fi

if [[ ! -f "${ROOT}/backend/public/bg-runtime.js" ]]; then
  log "Building runtime…"
  (cd "${ROOT}/runtime" && npm run build)
fi

run_scene() {
  local label="$1"
  local url="$2"
  local cache="${OUT}/cache-${label}"
  rm -rf "$cache"
  mkdir -p "$cache"
  local logf="${OUT}/${label}.log"
  log "Scene: ${label}"
  "$ENGINE" \
    --name="bench-${label}" \
    --url="$url" \
    --width=1920 --height=1080 --fps="$FPS" \
    --duration="$DUR" \
    --consumer=null \
    --cache-dir="$cache" \
    --blink-research=1 \
    > "$logf" 2>&1 || true

  local trace="${cache}/blink-trace.json"
  local wait=0
  while [[ ! -f "$trace" && $wait -lt 25 ]]; do
    sleep 1
    wait=$((wait + 1))
  done

  local summary
  summary=$(grep '^SUMMARY' "$logf" | tail -1 || echo 'SUMMARY missing')

  if [[ -f "$trace" ]]; then
    node "${ROOT}/engine/research/parse-trace-internals.mjs" \
      --in="$trace" --label="$label" \
      --out="${OUT}/${label}-trace-metrics.json" \
      | tee -a "${OUT}/${label}-trace.txt"
    node "${ROOT}/engine/research/parse-paint-invalidation.mjs" \
      --in="$trace" --out="${OUT}/${label}-invalidation.json" \
      | tee -a "${OUT}/${label}-invalidation.txt"
  else
    log "WARN: no trace at $trace"
  fi

  echo "${label}|${summary}" >> "${OUT}/summaries.txt"
}

file_url() {
  python3 -c "import pathlib; print(pathlib.Path('$1').resolve().as_uri())"
}

WIPE_INSET=$(file_url "${ROOT}/bench/bench-wipe-inset.html")
WIPE_POLY=$(file_url "${ROOT}/bench/bench-wipe-polygon.html")
WIPE_XFORM=$(file_url "${ROOT}/bench/bench-wipe-transform-only.html")
STATIC_BEACON_ON=$(file_url "${ROOT}/bench/bench-static-beacon.html")'?beacon=1'
STATIC_BEACON_OFF=$(file_url "${ROOT}/bench/bench-static-beacon.html")'?beacon=0'
IMG_LEFT=$(file_url "${ROOT}/bench/bench-image-left.html")
IMG_XFORM=$(file_url "${ROOT}/bench/bench-image-transform.html")

: > "${OUT}/summaries.txt"

run_scene wipe-inset "$WIPE_INSET"
run_scene wipe-polygon "$WIPE_POLY"
run_scene wipe-transform "$WIPE_XFORM"
run_scene static-beacon-on "$STATIC_BEACON_ON"
run_scene static-beacon-off "$STATIC_BEACON_OFF"
run_scene image-left "$IMG_LEFT"
run_scene image-transform "$IMG_XFORM"

# DOM breakdown from saved production template if present
TPL="${OUT}/../titulus-blink-research/template-d65d2a26-177c-47e2-ba1d-1ee285bdfaa5.json"
if [[ ! -f "$TPL" ]]; then
  TPL="/tmp/titulus-blink-research/template-d65d2a26-177c-47e2-ba1d-1ee285bdfaa5.json"
fi
if [[ -f "$TPL" ]]; then
  node "${ROOT}/engine/research/measure-dom-breakdown.mjs" \
    --template="$TPL" --out="${OUT}/dom-breakdown-prod.json"
fi

node "${ROOT}/engine/research/write-internals-doc.mjs" \
  --out-dir="$OUT" --doc="${ROOT}/docs/development-phases/phase-12-blink-pipeline.md"

log "Done. Report: ${ROOT}/docs/development-phases/phase-12-blink-pipeline.md"
log "Artifacts: ${OUT}/"
