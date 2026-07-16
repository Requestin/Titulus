#!/usr/bin/env bash
# Phase 19 Doc02 K2 — controlled ABBA wrapper around run_doc02_k2_gate.sh.
# Usage: run_doc02_k2_abba.sh 1ch|3ch [measured_seconds]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MODE="${1:?usage: $0 1ch|3ch [measured_seconds]}"
DURATION="${2:-60}"
CELL_RUNNER="$ROOT/engine/research/p19/run_doc02_k2_gate.sh"
SESSION_ROOT="${OUT_ROOT:-/tmp/titulus-doc02-k2-abba}/$(date -u +%Y%m%dT%H%M%SZ)-${MODE}"
CELLS_ROOT="$SESSION_ROOT/cells"

if [[ "$MODE" != "1ch" && "$MODE" != "3ch" ]]; then
  echo "mode must be 1ch|3ch" >&2
  exit 2
fi
if [[ ! -x "$CELL_RUNNER" ]]; then
  echo "cell runner is not executable: $CELL_RUNNER" >&2
  exit 1
fi

mkdir -p "$CELLS_ROOT"
: >"$SESSION_ROOT/cells.tsv"

run_cell() {
  local label="$1"
  local variant="$2"
  echo "[doc02-k2-abba] ${MODE} ${label} variant=${variant}"
  OUT_ROOT="$CELLS_ROOT" "$CELL_RUNNER" "$MODE" "$variant" "$DURATION"
  local path
  path="$(<"$CELLS_ROOT/last-run")"
  printf '%s\t%s\t%s\n' "$label" "$variant" "$path" \
    >>"$SESSION_ROOT/cells.tsv"
}

# A=control/off, B=treatment/on. Pair A1:B1 and A2:B2 conservatively.
run_cell A1 off
run_cell B1 on
run_cell B2 on
run_cell A2 off

python3 - "$SESSION_ROOT/cells.tsv" "$SESSION_ROOT/decision.json" \
  "$SESSION_ROOT/SUMMARY.txt" <<'PY'
import json
import sys
from pathlib import Path

cells_path, decision_path, summary_path = map(Path, sys.argv[1:])
cells: dict[str, dict] = {}
for line in cells_path.read_text().splitlines():
    label, variant, raw_path = line.split("\t")
    path = Path(raw_path)
    report = json.loads((path / "telemetry-summary.json").read_text())
    medians = [channel["in_fps"]["median"] for channel in report["channels"]]
    cells[label] = {
        "variant": variant,
        "path": str(path),
        "channel_median_in_fps": medians,
    }

ratios: list[dict] = []
for control, treatment in (("A1", "B1"), ("A2", "B2")):
    a = cells[control]["channel_median_in_fps"]
    b = cells[treatment]["channel_median_in_fps"]
    if len(a) != len(b):
        raise SystemExit(f"channel count mismatch: {control}/{treatment}")
    for channel, (baseline, candidate) in enumerate(zip(a, b)):
        if baseline <= 0:
            raise SystemExit(f"non-positive control median: {control} ch{channel}")
        ratios.append({
            "control": control,
            "treatment": treatment,
            "channel": channel,
            "control_median_in_fps": baseline,
            "treatment_median_in_fps": candidate,
            "uplift": round(candidate / baseline, 4),
        })

worst = min(item["uplift"] for item in ratios)
channel_count = len(cells["A1"]["channel_median_in_fps"])
if channel_count == 1:
    # 1ch is clock-capped and therefore a non-regression/active-path smoke,
    # not an uplift gate. K2's decision is made by the paired 3ch cells.
    treatment_floor = min(
        cells[label]["channel_median_in_fps"][0] for label in ("B1", "B2")
    )
    verdict = (
        "SMOKE_PASS"
        if worst >= 0.95 and treatment_floor >= 45.0
        else "SMOKE_FAIL"
    )
    criteria = {
        "treatment_median_in_fps_ge": 45.0,
        "paired_non_regression_ge": 0.95,
    }
else:
    verdict = "PASS" if worst >= 1.5 else "ITERATE" if worst >= 1.2 else "STOP"
    criteria = {"pass_ge": 1.5, "iterate_ge": 1.2, "stop_lt": 1.2}
decision = {
    "gate": "K2",
    "design": "ABBA",
    "mode": f"{channel_count}ch",
    "cells": cells,
    "paired_channel_uplifts": ratios,
    "worst_paired_channel_uplift": worst,
    "criteria": criteria,
    "verdict": verdict,
}
decision_path.write_text(json.dumps(decision, indent=2) + "\n")

lines = [
    "=== DOC02 K2 ABBA ===",
    f"worst_paired_channel_uplift={worst:.4f}",
    f"verdict={verdict}",
]
for item in ratios:
    lines.append(
        f"{item['control']}:{item['treatment']} ch{item['channel']} "
        f"{item['control_median_in_fps']}->{item['treatment_median_in_fps']} "
        f"uplift={item['uplift']:.4f}"
    )
summary = "\n".join(lines) + "\n"
summary_path.write_text(summary)
print(summary, end="")
PY

echo "[doc02-k2-abba] done: $SESSION_ROOT"
