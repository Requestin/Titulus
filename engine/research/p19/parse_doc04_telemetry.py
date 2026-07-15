#!/usr/bin/env python3
"""Aggregate per-window DeckLink telemetry for Phase 19 doc04."""

from __future__ import annotations

import argparse
import json
import re
import statistics
from pathlib import Path
from typing import Any


FIELDS = (
    "in_fps",
    "d_pairs",
    "d_singles",
    "d_starved",
    "d_late",
    "d_dropped",
    "d_flushed",
)


def parse_windows(path: Path) -> list[dict[str, float | str]]:
    windows: list[dict[str, float | str]] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if "telemetry5s " not in line:
            continue
        values: dict[str, float | str] = {}
        for field in FIELDS:
            match = re.search(rf"\b{field}=([0-9.]+)", line)
            if match:
                values[field] = float(match.group(1))
        ref = re.search(r"\bref=([A-Za-z_]+)", line)
        values["ref"] = ref.group(1) if ref else "missing"
        if "in_fps" in values:
            windows.append(values)
    return windows


def stats(values: list[float]) -> dict[str, float]:
    return {
        "average": round(statistics.fmean(values), 2),
        "median": round(statistics.median(values), 2),
        "minimum": round(min(values), 2),
        "maximum": round(max(values), 2),
    }


def summarize(path: Path) -> dict[str, Any]:
    windows = parse_windows(path)
    if not windows:
        raise ValueError(f"{path}: no telemetry5s windows")

    report: dict[str, Any] = {"log": str(path), "windows": len(windows)}
    for field in ("in_fps", "d_pairs", "d_singles"):
        report[field] = stats([float(window.get(field, 0.0)) for window in windows])
    for field in ("d_starved", "d_late", "d_dropped", "d_flushed"):
        report[f"{field}_sum"] = int(sum(float(window.get(field, 0.0)) for window in windows))
    report["ref_unlock_windows"] = sum(
        window["ref"] != "locked" for window in windows
    )
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("logs", type=Path, nargs="+")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    result = {"channels": [summarize(path) for path in args.logs]}
    rendered = json.dumps(result, indent=2, sort_keys=True)
    if args.out:
        args.out.write_text(rendered + "\n", encoding="utf-8")
    else:
        print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
