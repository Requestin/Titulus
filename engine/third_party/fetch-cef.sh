#!/usr/bin/env bash
# Download and extract CEF minimal (linux64) for bg_engine build.
# DEVELOPMENT_PROMPT §9.1: CEF 148+, linux64 minimal distribution.
# Output: engine/third_party/cef/<cef_binary_...>/  (libcef.so, include/, Resources/, libcef_dll_wrapper/)
#
# Set TITULUS_CEF_ARCHIVE to an exact archive name to reproduce a known build.
# Without it, the latest stable minimal archive is selected.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CEF_DIR="$SCRIPT_DIR/cef"
mkdir -p "$CEF_DIR"
cd "$CEF_DIR"

INDEX_URL="https://cef-builds.spotifycdn.com/index.json"
REQUESTED_NAME="${TITULUS_CEF_ARCHIVE:-}"

# Resolve latest stable linux64 minimal from the official index.
# Pipe the JSON through stdin to python to avoid ARG_MAX on the large payload.
META_JSON="$(curl -fsS "$INDEX_URL")"
read -r NAME SHA1 VERSION <<< "$(printf '%s' "$META_JSON" | TITULUS_CEF_ARCHIVE="$REQUESTED_NAME" python3 -c "
import json, os, sys
d = json.load(sys.stdin)
requested = os.environ.get('TITULUS_CEF_ARCHIVE')
for v in d['linux64']['versions']:
    for f in v['files']:
        if f['type'] != 'minimal':
            continue
        if requested:
            if f['name'] != requested:
                continue
        elif v['channel'] != 'stable':
            continue
        print(f['name'], f['sha1'], v['cef_version'].split('+')[0])
        raise SystemExit
")"

if [[ -z "${NAME:-}" ]]; then
  if [[ -n "$REQUESTED_NAME" ]]; then
    echo "[fetch-cef] requested archive was not found: $REQUESTED_NAME" >&2
  else
    echo "[fetch-cef] could not resolve a stable linux64 minimal build from $INDEX_URL" >&2
  fi
  exit 1
fi
if [[ -n "$REQUESTED_NAME" ]]; then
  echo "[fetch-cef] pinned minimal: cef=$VERSION  $NAME"
else
  echo "[fetch-cef] latest stable minimal: cef=$VERSION  $NAME"
fi

# Idempotent: skip if already extracted for this exact version.
STAMP="$CEF_DIR/.cef_fetched"
if [[ -f "$STAMP" ]] && grep -qx "$NAME" "$STAMP" && ls -d "$CEF_DIR"/cef_binary_*_linux64_* >/dev/null 2>&1; then
  echo "[fetch-cef] already fetched ($NAME); skipping"
  exit 0
fi

TARBALL="$CEF_DIR/$NAME"
URL="https://cef-builds.spotifycdn.com/$NAME"
echo "[fetch-cef] downloading from $URL"
curl -fL --retry 3 -o "$TARBALL" "$URL"

# Verify sha1.
ACTUAL="$(sha1sum "$TARBALL" | awk '{print $1}')"
if [[ "$ACTUAL" != "$SHA1" ]]; then
  echo "[fetch-cef] SHA1 mismatch: expected $SHA1 got $ACTUAL" >&2
  exit 1
fi
echo "[fetch-cef] sha1 OK ($SHA1)"

echo "[fetch-cef] extracting..."
tar -xjf "$TARBALL" -C "$CEF_DIR"
rm -f "$TARBALL"

EXTRACTED="$(ls -d "$CEF_DIR"/cef_binary_*_linux64_* | head -1)"
printf '%s\n' "$NAME" > "$STAMP"
echo "[fetch-cef] done: $EXTRACTED"
ls "$EXTRACTED"
