#!/usr/bin/env bash
# engine/collect-decklink-evidence.sh
#
# Prepare a validation evidence bundle for Phase 6.4 DeckLink HW acceptance.
# Can be run on both dev host (dry metadata prep) and hardware host.

set -euo pipefail

BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:3001}"
OUT_ROOT="${OUT_ROOT:-/var/log/titulus}"
API_TOKEN="${TITULUS_API_TOKEN:-}"
API_USER="${TITULUS_API_USER:-admin}"
API_PASSWORD="${TITULUS_API_PASSWORD:-admin123}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--out-root DIR] [--backend-url URL]

Environment:
  BACKEND_URL             default http://127.0.0.1:3001
  OUT_ROOT                default /var/log/titulus
  TITULUS_API_TOKEN       optional bearer token
  TITULUS_API_USER        default admin (when token absent)
  TITULUS_API_PASSWORD    default admin123 (when token absent)

Output folder:
  <OUT_ROOT>/phase6-sdi-YYYYMMDD-HHMMSS/
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-root) OUT_ROOT="$2"; shift 2 ;;
    --backend-url) BACKEND_URL="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

require_cmd curl
require_cmd python3

if [[ -z "$API_TOKEN" ]]; then
  payload="$(API_USER="$API_USER" API_PASSWORD="$API_PASSWORD" python3 -c "import json, os; print(json.dumps({'username': os.environ['API_USER'], 'password': os.environ['API_PASSWORD']}))")"
  login="$(curl -sf -H 'Content-Type: application/json' -d "$payload" "${BACKEND_URL}/api/auth/login" || true)"
  if [[ -n "$login" ]]; then
    API_TOKEN="$(python3 -c "import json, sys; print(json.load(sys.stdin).get('token', ''))" <<<"$login" 2>/dev/null || true)"
  fi
fi

if [[ -z "$API_TOKEN" ]]; then
  echo "failed to obtain auth token; set TITULUS_API_TOKEN or valid user/password" >&2
  exit 1
fi

stamp="$(date +%Y%m%d-%H%M%S)"
out_dir="${OUT_ROOT}/phase6-sdi-${stamp}"
mkdir -p "$out_dir"

echo "[evidence] creating bundle: $out_dir"

{
  echo "timestamp=$(date --iso-8601=seconds)"
  echo "hostname=$(hostname)"
  echo "kernel=$(uname -srmo)"
  echo "backend_url=${BACKEND_URL}"
  echo "nproc=$(nproc || true)"
  echo "ffmpeg=$(ffmpeg -version 2>/dev/null | awk 'NR==1 {print $0}' || echo 'not-found')"
  echo "decklink_sdk_include=${DECKLINK_SDK_INCLUDE:-unset}"
  echo "decklink_driver_hint=run Desktop Video tools on HW host to capture exact version"
} >"${out_dir}/env.txt"

curl -sf -H "Authorization: Bearer ${API_TOKEN}" "${BACKEND_URL}/api/channels" >"${out_dir}/channels.json" || {
  echo "[]" >"${out_dir}/channels.json"
}

cat >"${out_dir}/soak-summary.txt" <<'EOF'
Phase 6.4 soak summary template

- Duration:
- Channel profile:
- Genlock lock ratio:
- Drops/restarts:
- Observed anomalies:
- Verdict:
EOF

cat >"${out_dir}/ab-notes.md" <<'EOF'
# A/B Notes (CasparCG vs bg_engine)

- Template set:
- Viewer monitor + scope setup:
- Motion parity notes:
- Alpha/key edges notes:
- Color/parade/vectorscope notes:
- Final judgement:
EOF

cat >"${out_dir}/reference-lock.log" <<'EOF'
# Append periodic reference-lock samples here (timestamp, lock_state, source)
EOF

echo "[evidence] done"
echo "[evidence] env: ${out_dir}/env.txt"
echo "[evidence] channels: ${out_dir}/channels.json"
echo "[evidence] fill these manually on HW run:"
echo "  - ${out_dir}/soak-summary.txt"
echo "  - ${out_dir}/ab-notes.md"
echo "  - ${out_dir}/reference-lock.log"
