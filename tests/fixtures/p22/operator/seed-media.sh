#!/usr/bin/env bash
# Copy the pinned P22 operator media into a TITULUS_DATA tree.
# Air path is WebP. Source .webm stays in media/source/ and is not copied.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <TITULUS_DATA>" >&2
  exit 2
fi

DATA="$1"
HERE="$(cd "$(dirname "$0")" && pwd)"
MEDIA="$HERE/media"

mkdir -p "$DATA/uploads" "$DATA/data-files"
cp -f "$MEDIA/p22-newtest-1.jpg" "$DATA/uploads/"
cp -f "$MEDIA/p22-newtest-2.png" "$DATA/uploads/"
cp -f "$MEDIA/p22-newtest-3.jpg" "$DATA/uploads/"
cp -f "$MEDIA/p22-newtest-video1.webp" "$DATA/uploads/"
cp -f "$MEDIA/p22-newtest-video2.webp" "$DATA/uploads/"
cp -f "$MEDIA/p22-newtest1-crawl.txt" "$DATA/data-files/"
echo "seeded P22 operator media into $DATA"
