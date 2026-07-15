#!/usr/bin/env bash
# Collect a non-invasive scheduling evidence bundle for one DeckLink session.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PARSER="${ROOT}/engine/research/p19/parse_doc04_telemetry.py"
LOGS_DIR="${ROOT}/logs"
OUT_DIR=""
LOCK_FILE="${TITULUS_DOC04_LOCK:-/tmp/titulus-doc04-decklink.lock}"

usage() {
  cat <<'EOF'
Usage: collect-doc04-evidence.sh --out-dir DIR [--logs-dir DIR]

Exclusive, read-only collection for one existing DeckLink session.
The script never starts, stops, reprioritizes, or repins an engine. It takes
an exclusive host lock so concurrent doc04 collectors cannot mix evidence.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --logs-dir) LOGS_DIR="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "collect-doc04-evidence.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$OUT_DIR" ]]; then
  echo "collect-doc04-evidence.sh: --out-dir is required" >&2
  exit 2
fi
if [[ ! -f "$PARSER" ]]; then
  echo "collect-doc04-evidence.sh: missing parser: $PARSER" >&2
  exit 2
fi

mkdir -p "$OUT_DIR/raw-logs"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "collect-doc04-evidence.sh: another doc04 hardware collection owns $LOCK_FILE" >&2
  exit 75
fi

mapfile -t logs < <(compgen -G "${LOGS_DIR}/engine-*.log" || true)
if [[ ${#logs[@]} -eq 0 ]]; then
  echo "collect-doc04-evidence.sh: no per-channel logs in $LOGS_DIR" >&2
  exit 1
fi

{
  echo "timestamp=$(date --iso-8601=seconds)"
  echo "kernel=$(uname -srmo)"
  echo "cmdline=$(< /proc/cmdline)"
  echo "governor=$(tr '\n' ',' < /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor)"
  echo "thp=$(< /sys/kernel/mm/transparent_hugepage/enabled)"
  echo "irqbalance=$(systemctl is-active irqbalance 2>&1 || true)"
  echo "rtprio_limit=$(ulimit -r)"
  echo "engines=$(pgrep -af 'bg_engine|run-channel|run-engines' 2>/dev/null |
    python3 -c 'import re, sys; print(re.sub(r"TITULUS_API_PASSWORD=[^ ]+", "TITULUS_API_PASSWORD=REDACTED", sys.stdin.read()), end="")' || true)"
  echo "decklink_irq_71=$(< /proc/irq/71/effective_affinity_list 2>/dev/null || true)"
  echo "decklink_irq_73=$(< /proc/irq/73/effective_affinity_list 2>/dev/null || true)"
} > "${OUT_DIR}/host.env"

LC_ALL=C lscpu -p=CPU,CORE,SOCKET,NODE > "${OUT_DIR}/host-lscpu.csv"
for log in "${logs[@]}"; do
  cp "$log" "${OUT_DIR}/raw-logs/$(basename "$log")"
done
python3 "$PARSER" "${OUT_DIR}"/raw-logs/engine-*.log --out "${OUT_DIR}/telemetry-summary.json"
echo "[doc04] evidence collected in $OUT_DIR"
