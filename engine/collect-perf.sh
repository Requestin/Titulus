#!/usr/bin/env bash
set -euo pipefail

CHANNEL="${1:-2}"          # 1, 2 или 3
SECS="${2:-15}"
CACHE=( "" "6fbc1394" "8e78d06a" "95a844f9" )
C="${CACHE[$CHANNEL]}"

MAIN=$(pgrep -af "cache-${C}" | grep 'consumer=decklink' | grep -v -- '--type=' | head -1 | awk '{print $1}')
REN=$(pgrep -af "cache-${C}" | grep 'renderer-client-id=5' | head -1 | awk '{print $1}')

if [[ -z "$MAIN" || -z "$REN" ]]; then
  echo "ERROR: could not find main/renderer PIDs for channel $CHANNEL (cache prefix ${C})" >&2
  exit 1
fi

echo "Channel $CHANNEL: main=$MAIN renderer=$REN (${SECS}s)"
perf record -F 99 -g --call-graph fp -p "$REN" -o "/tmp/titulus-ch${CHANNEL}-renderer.data" -- sleep "$SECS"
perf record -F 99 -g --call-graph fp -p "$MAIN" -o "/tmp/titulus-ch${CHANNEL}-main.data"     -- sleep "$SECS"

echo "=== Renderer top ==="
perf report -i "/tmp/titulus-ch${CHANNEL}-renderer.data" --stdio --no-children --percent-limit 3 | head -40
echo "=== Main top ==="
perf report -i "/tmp/titulus-ch${CHANNEL}-main.data" --stdio --no-children --percent-limit 3 | head -40