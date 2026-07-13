#!/usr/bin/env bash
# engine/research/lib/sample-threads.sh — per-thread CPU sampling of a running
# bg_engine (or its CEF renderer subprocess) for Phase 17 performance
# research: which threads (main, CompositorTileWorker, Compositor, etc.)
# are actually consuming CPU, to see whether the raster thread pool is
# running near-idle (supports hypothesis B: IPC-latency bound) or fully
# busy (supports hypothesis A: raster pool undersaturated/saturated).
#
# Usage: sample-threads.sh <PID> [DURATION_SEC] [OUT_CSV]
# Example: sample-threads.sh $(pgrep -f "type=renderer" | head -1) 30 /tmp/renderer-threads.csv
#
# Caller is responsible for process discovery (e.g. pgrep -f "type=renderer")
# — this script only samples a given PID.
set -euo pipefail

PID="${1:?PID required, e.g. sample-threads.sh <PID> [DURATION_SEC] [OUT_CSV]}"
DURATION_SEC="${2:-30}"
OUT_CSV="${3:-/tmp/sample-threads-${PID}.csv}"

echo "sample_ts,pid,tid,pcpu,stat,comm" > "$OUT_CSV"

echo "[sample-threads] sampling pid=$PID every 1s for ${DURATION_SEC}s -> $OUT_CSV"

for ((i = 0; i < DURATION_SEC; i++)); do
  ts="$(date +%s)"

  if ! sample="$(ps -T -p "$PID" -o pid,tid,pcpu,stat,comm --no-headers 2>/dev/null)"; then
    echo "[sample-threads] WARN: pid $PID disappeared (ps failed) — stopping early at t=${i}s" >&2
    break
  fi

  if [[ -z "$sample" ]]; then
    echo "[sample-threads] WARN: pid $PID disappeared (no ps output) — stopping early at t=${i}s" >&2
    break
  fi

  # ps -T columns are whitespace-separated; squeeze runs of whitespace and
  # join with commas. comm has no embedded spaces so this is safe.
  echo "$sample" | awk -v ts="$ts" '{
    $1 = $1;
    gsub(/ /, ",");
    print ts "," $0;
  }' >> "$OUT_CSV"

  sleep 1
done

echo "[sample-threads] done -> $OUT_CSV"
echo ""
echo "Per-thread-name (comm) summary across all samples:"
echo "  (sum %CPU of tids sharing a comm per timestamp, then max/mean across timestamps)"

# For each (sample_ts, comm) sum pcpu across tids sharing that comm, then
# compute the max and mean of that per-timestamp sum across all timestamps,
# grouped by comm — matches Chromium reusing generic thread names (e.g.
# CompositorTileWorker) for a whole pool of threads.
awk -F',' '
  NR == 1 { next }  # skip header
  {
    key = $1 SUBSEP $6
    persum[key] += $4
    comms[$6] = 1
  }
  END {
    for (k in persum) {
      split(k, parts, SUBSEP)
      comm = parts[2]
      v = persum[k]
      if (!(comm in cnt)) { cnt[comm] = 0; sum[comm] = 0; max[comm] = -1 }
      cnt[comm] += 1
      sum[comm] += v
      if (v > max[comm]) max[comm] = v
    }
    printf "%-28s %10s %10s\n", "comm", "max_pcpu", "mean_pcpu"
    for (comm in comms) {
      if (cnt[comm] == 0) continue
      mean = sum[comm] / cnt[comm]
      printf "%-28s %10.1f %10.1f\n", comm, max[comm], mean
    }
  }
' "$OUT_CSV"
