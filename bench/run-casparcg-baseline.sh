#!/usr/bin/env bash
# bench/run-casparcg-baseline.sh — drive CasparCG 2.5's HTML Producer with the
# bench.html scene to confirm the reference renderer accepts the scene and plays
# it on a 1080p50 channel (DEVELOPMENT_PROMPT §11.1 baseline reference).
#
# What this measures:
#   - CasparCG boots headless, the HTML producer loads bench.html, AMCP PLAY
#     returns 202 OK, and the channel drives the producer at 1080p50. The libx264
#     frame counts in the teardown summary are recorded as INFORMATIONAL context
#     (encoded-frame totals, not a real-time fps read — libx264 runs async with
#     bframes/lookahead, so the encoded count ≠ displayed fps).
#
# What this does NOT measure (honest limitation):
#   - CasparCG's authoritative per-channel fps/dropped-frame counters live in its
#     diagnostic graph / OSC output, not the main log, and capturing them
#     headless needs an OSC consumer (not bundled). The formal, comparable
#     baseline fps/drops number therefore lands when we run on bare-metal with
#     SDI (Phase 3) or wire an OSC capture. See docs/PHASE0_BENCH.md.
#
# Usage:
#   ./bench/run-casparcg-baseline.sh [duration_sec] [graphics_per_channel]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DURATION="${1:-60}"
GRAPHICS="${2:-5}"

CASPARCG_BIN="$(command -v casparcg-server-2.5 || true)"
if [[ -z "$CASPARCG_BIN" ]]; then
  echo "[casparcg-baseline] casparcg-server-2.5 not found on PATH; install the .deb first" >&2
  exit 1
fi
if [[ ! -d /usr/lib/casparcg-cef-142 ]]; then
  echo "[casparcg-baseline] casparcg-cef-142 not installed (libcef needed at runtime)" >&2
  exit 1
fi

export LD_LIBRARY_PATH="/usr/lib/casparcg-cef-142:${LD_LIBRARY_PATH:-}"

WORK="$(mktemp -d -t cg-bench-XXXXXX)"
KEEP_LOG="${WORK}/server.log"
trap 'pkill -f "casparcg-server-2.5" 2>/dev/null || true; echo "[casparcg-baseline] server log kept at: ${KEEP_LOG}"' EXIT
mkdir -p "$WORK"/media "$WORK"/log "$WORK"/data "$WORK"/template

cp bench/casparcg/casparcg-bench.config "$WORK/casparcg.config"
BENCH_URL="file://${ROOT}/bench/bench.html?graphics=${GRAPHICS}"

echo "[casparcg-baseline] starting server (channel 1 @ 1080p50)..."
( cd "$WORK" && "$CASPARCG_BIN" > "$WORK/server.log" 2>&1 ) &
CG_PID=$!

amcp() {
  # CasparCG keeps the AMCP connection open after replying; read with a timeout.
  exec 3<>/dev/tcp/127.0.0.1/5250
  printf '%s\r\n' "$1" >&3
  timeout 4 head -c 400 <&3 || true
  exec 3>&- 3<&-
}

echo "[casparcg-baseline] waiting for AMCP on 127.0.0.1:5250 ..."
ready=0
for _ in $(seq 1 30); do
  if (exec 3<>/dev/tcp/127.0.0.1/5250) 2>/dev/null; then exec 3>&- 3<&-; ready=1; break; fi
  sleep 1
done
if [[ $ready -ne 1 ]]; then
  echo "[casparcg-baseline] AMCP did not come up; server log:" >&2
  tail -20 "$WORK/server.log" >&2
  exit 1
fi

echo "[casparcg-baseline] PLAY 1-10 [HTML] \"${BENCH_URL}\""
play_resp="$(amcp "PLAY 1-10 [HTML] \"${BENCH_URL}\"" || true)"
echo "$play_resp" | head -2
echo "$play_resp" | grep -q "202 PLAY OK" || {
  echo "[casparcg-baseline] PLAY did not return 202 OK; aborting" >&2
  exit 1
}

echo "[casparcg-baseline] playing for ${DURATION}s..."
sleep "$DURATION"

# STOP the layer to tear the producer/consumer down, then BYE to stop the
# server so libx264 flushes its teardown summary to the log.
amcp "STOP 1-10" >/dev/null 2>&1 || true
sleep 2
amcp "BYE" >/dev/null 2>&1 || true
for _ in $(seq 1 8); do kill -0 "$CG_PID" 2>/dev/null || break; sleep 1; done
kill "$CG_PID" 2>/dev/null || true
wait "$CG_PID" 2>/dev/null || true

# Informational: libx264 encoded-frame totals from the teardown summary. NOT a
# real-time fps read (async encode with bframes/lookahead), recorded for context.
frame_I="$(grep -oE 'frame I:[ ]*[0-9]+' "$WORK/server.log" | tail -1 | grep -oE '[0-9]+' || echo 0)"
frame_P="$(grep -oE 'frame P:[ ]*[0-9]+' "$WORK/server.log" | tail -1 | grep -oE '[0-9]+' || echo 0)"
frame_B="$(grep -oE 'frame B:[ ]*[0-9]+' "$WORK/server.log" | tail -1 | grep -oE '[0-9]+' || echo 0)"
total_enc="$(awk -v i="$frame_I" -v p="$frame_P" -v b="$frame_B" 'BEGIN { print i+p+b }')"

echo
echo "================ casparcg baseline summary ================"
printf 'scene: bench.html?graphics=%s  play_duration: %ss  channel: 1080p50\n' "$GRAPHICS" "$DURATION"
echo "AMCP PLAY ............ 202 OK (scene accepted, producer loaded)"
printf 'libx264 encoded (info, NOT real-time fps): I=%s P=%s B=%s total=%s\n' \
  "$frame_I" "$frame_P" "$frame_B" "$total_enc"
echo "-----------------------------------------------------------"
echo "NOTE: CasparCG's authoritative fps/dropped-frame counters live in its"
echo "      diagnostic graph / OSC output, not the main log. The comparable"
echo "      baseline fps/drops number lands with OSC capture or bare-metal SDI"
echo "      (Phase 3). See docs/PHASE0_BENCH.md. What we confirmed headless:"
echo "      the reference renderer accepts and plays our bench scene at 1080p50."
echo "==========================================================="
echo "[casparcg-baseline] server log: ${KEEP_LOG}"
