#!/usr/bin/env bash
# Re-encode opaque WebM clips without alpha_mode (CEF OSR decode relief on SDI).
# Keeps originals as *.webm.bak next to the file.
#
# Usage:
#   ./backend/scripts/reencode-opaque-webm.sh [/var/lib/titulus/uploads/Video]
set -euo pipefail

DIR="${1:-/var/lib/titulus/uploads/Video}"
if [[ ! -d "$DIR" ]]; then
  echo "dir not found: $DIR" >&2
  exit 1
fi

shopt -s nullglob
count=0
for f in "$DIR"/*.webm; do
  base="$(basename "$f")"
  # skip posters
  [[ "$base" == *_poster* ]] && continue
  alpha="$(ffprobe -v error -select_streams v:0 -show_entries stream_tags=alpha_mode -of default=nw=1:nk=1 "$f" 2>/dev/null || true)"
  if [[ "$alpha" != "1" ]]; then
    echo "skip (no alpha_mode): $base"
    continue
  fi
  tmp="$f.reenc.webm"
  bak="$f.bak"
  echo "re-encode opaque VP8: $base"
  ffmpeg -y -hide_banner -loglevel error -i "$f" -an -map_metadata -1 \
    -c:v libvpx -vf format=yuv420p \
    -b:v 0 -crf 22 -deadline good -cpu-used 4 "$tmp"
  mv -f "$f" "$bak"
  mv -f "$tmp" "$f"
  count=$((count + 1))
done

echo "done: re-encoded $count file(s) in $DIR"
echo "backups: *.webm.bak — delete after verifying SDI"
