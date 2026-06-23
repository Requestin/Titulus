#!/usr/bin/env bash
# bench/run-bench.sh — multi-channel bg_engine benchmark harness
# (DEVELOPMENT_PROMPT §11.1, §11.2).
#
# Launches N independent bg_engine processes (one per channel), each pinned to
# a disjoint set of physical cores via taskset, each rendering the bench scene.
# Captures per-engine fps/drops from each SUMMARY line plus overall CPU%.
#
# Usage:
#   ./run-bench.sh [channels] [duration_sec] [graphics_per_channel]
#
# Defaults: channels=3, duration=60, graphics=5  (MVP acceptance: 3ch 30min soak)
#
# Acceptance (§11.2): 3 channels @ 1080p50, interval p50 = 20ms, drops < 0.1%
# bare-metal, fps >= CasparCG CPU baseline. Mask/alpha A/B is separate
# (bench-alpha.html).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CHANNELS="${1:-3}"
DURATION="${2:-60}"
GRAPHICS="${3:-5}"

ENGINE_BIN="${ROOT}/engine/build/Release/bg_engine"
BENCH_URL="file://${ROOT}/bench/bench.html?graphics=${GRAPHICS}"
FPS="${FPS:-50}"
WIDTH="${WIDTH:-1920}"
HEIGHT="${HEIGHT:-1080}"

if [[ ! -x "$ENGINE_BIN" ]]; then
  echo "[bench] bg_engine not found at $ENGINE_BIN" >&2
  echo "[bench] build it first: cd engine && cmake -B build -DCMAKE_BUILD_TYPE=Release && make -C build -j" >&2
  exit 1
fi

# Physical core discovery — 2 dedicated cores per channel (§4.3, §11.3).
# We read the actual physical core count from /proc/cpuinfo (socket * cores).
phys_cores="$(lscpu | awk '/^Core\(s\) per socket:/ {c=$4} /^Socket\(s\):/ {s=$4} END {print c*s}')"
if [[ -z "$phys_cores" || "$phys_cores" -eq 0 ]]; then
  phys_cores="$(nproc)"
fi
cores_per_channel=2
total_needed=$((CHANNELS * cores_per_channel))
if [[ "$phys_cores" -lt "$total_needed" ]]; then
  echo "[bench] WARNING: ${phys_cores} physical cores < ${total_needed} needed for ${CHANNELS}ch @${cores_per_channel}c/ch" >&2
  echo "[bench]          results will reflect contention, not clean channel isolation" >&2
fi
echo "[bench] host: ${phys_cores} physical cores; ${CHANNELS}ch x ${cores_per_channel}c = ${total_needed} pinned cores"

WORK="$(mktemp -d -t bg-bench-XXXXXX)"
trap 'rm -rf "$WORK"; pkill -f "bg_engine.*bg-bench" 2>/dev/null || true' EXIT

declare -a PIDS=()
LOGS=()

core=0
for ((i=0; i<CHANNELS; i++)); do
  core_start=$core
  core_end=$((core + cores_per_channel - 1))
  cache="${WORK}/cache-ch${i}"
  log="${WORK}/ch${i}.log"
  mkdir -p "$cache"
  LOGS+=("$log")

  echo "[bench] ch${i}: cores ${core_start}-${core_end} -> ${log##*/}"
  taskset -c "${core_start}-${core_end}" "$ENGINE_BIN" \
    --url="${BENCH_URL}" \
    --width="$WIDTH" --height="$HEIGHT" --fps="$FPS" \
    --duration="$DURATION" --stats-interval="$((DURATION / 4 > 0 ? DURATION / 4 : 1))" \
    --consumer=null \
    --cache-dir="$cache" \
    --name="bench-ch${i}" \
    > "$log" 2>&1 &
  PIDS+=("$!")
  core=$((core + cores_per_channel))
done

# Snapshot total CPU jiffies before the run for an overall CPU% read.
CPU_T0="$(awk '/^cpu / {print $2+$3+$4+$5+$6+$7+$8+$9+$10; exit}' /proc/stat)"

# Wait for all channels to finish.
fail=0
for pid in "${PIDS[@]}"; do
  if ! wait "$pid"; then
    echo "[bench] engine pid $pid exited non-zero" >&2
    fail=1
  fi
done

CPU_T1="$(awk '/^cpu / {print $2+$3+$4+$5+$6+$7+$8+$9+$10; exit}' /proc/stat)"
# Engine duration is fixed at $DURATION; use it as the wall window for CPU%.
elapsed_s="$DURATION"
cpu_busy_pct="$(awk -v t0="$CPU_T0" -v t1="$CPU_T1" -v n="$phys_cores" -v s="$elapsed_s" \
  'BEGIN { if (s>0 && n>0) printf "%.1f", 100*(t1-t0)/(100*s*n); else print "n/a" }')"

echo
echo "================ bench summary ================"
printf 'channels=%d duration=%ss graphics=%d fps_target=%d host_cores=%d cpu_used=%s%%\n' \
  "$CHANNELS" "$elapsed_s" "$GRAPHICS" "$FPS" "$phys_cores" "$cpu_busy_pct"
echo "-----------------------------------------------"
printf '%-6s %-8s %-14s %-14s %-14s %-8s %-8s\n' "ch" "fps" "p50_us" "p99_us" "p999_us" "late" "drops%"
total_fps=0
for ((i=0; i<${#LOGS[@]}; i++)); do
  line="$(grep -oE 'SUMMARY .*' "${LOGS[$i]}" | tail -1 || true)"
  if [[ -z "$line" ]]; then
    printf '%-6s %s\n' "ch${i}" "NO SUMMARY"
    continue
  fi
  fps="$(echo "$line" | grep -oE 'fps=[0-9.]+' | head -1 | cut -d= -f2)"
  p50="$(echo "$line"  | grep -oE 'interval_p50_us=[0-9]+' | cut -d= -f2)"
  p99="$(echo "$line"  | grep -oE 'interval_p99_us=[0-9]+' | cut -d= -f2)"
  p999="$(echo "$line" | grep -oE 'interval_p999_us=[0-9]+' | cut -d= -f2)"
  late="$(echo "$line" | grep -oE 'late=[0-9]+' | cut -d= -f2)"
  drops="$(echo "$line" | grep -oE 'drops=[0-9.]+%?' | cut -d= -f2)"
  printf 'ch%-5d %-8s %-14s %-14s %-14s %-8s %-8s\n' "$i" "$fps" "$p50" "$p99" "$p999" "$late" "$drops"
  total_fps="$(awk -v t="$total_fps" -v f="$fps" 'BEGIN {print t+f}')"
done
echo "==============================================="
avg_fps="$(awk -v t="$total_fps" -v n="$CHANNELS" 'BEGIN { if(n>0) printf "%.2f", t/n }')"
echo "[bench] avg_fps=${avg_fps} (target ${FPS}); per-channel logs in ${WORK}/  (kept until script exits)"

exit $fail
