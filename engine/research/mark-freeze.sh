#!/usr/bin/env bash
set -euo pipefail

out="${1:-operator_marks.csv}"
header='unix_us,event,note'

if [[ ! -e "$out" ]]; then
  printf '%s\n' "$header" > "$out"
elif [[ ! -f "$out" ]]; then
  printf '[mark-freeze] output is not a regular file: %s\n' "$out" >&2
  exit 1
else
  IFS= read -r existing_header < "$out" || true
  if [[ "$existing_header" != "$header" ]]; then
    printf '[mark-freeze] refusing incompatible CSV header in %s\n' "$out" >&2
    exit 1
  fi
fi

printf '[mark-freeze] f=freeze; c=control; q=exit -> %s\n' "$out"
while IFS= read -rsn1 input; do
  if [[ "$input" == 'q' || "$input" == 'Q' ]]; then
    printf '\n[mark-freeze] exit\n'
    break
  fi
  unix_us="$(date +%s%6N)"
  if [[ "$input" == 'c' || "$input" == 'C' ]]; then
    event='control'
  elif [[ "$input" == 'f' || "$input" == 'F' || "$input" == $'\n' || "$input" == $'\r' ]]; then
    event='freeze'
  else
    continue
  fi
  printf '%s,%s,\n' "$unix_us" "$event" >> "$out"
  printf '[mark-freeze] %s @ %s\n' "$event" "$unix_us"
done
