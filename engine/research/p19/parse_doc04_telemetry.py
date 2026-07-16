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
    for line_number, line in enumerate(
        path.read_text(encoding="utf-8", errors="replace").splitlines(),
        start=1,
    ):
        if "telemetry5s " not in line:
            continue
        values: dict[str, float | str] = {}
        for field in FIELDS:
            match = re.search(rf"\b{field}=([0-9.]+)", line)
            if match:
                values[field] = float(match.group(1))
        ref = re.search(r"\bref=([A-Za-z_]+)", line)
        missing = [field for field in FIELDS if field not in values]
        if not ref:
            missing.append("ref")
        if missing:
            raise ValueError(
                f"{path}:{line_number}: missing telemetry fields: {','.join(missing)}"
            )
        values["ref"] = ref.group(1)
        windows.append(values)
    return windows


def stats(values: list[float]) -> dict[str, float]:
    return {
        "average": round(statistics.fmean(values), 2),
        "median": round(statistics.median(values), 2),
        "minimum": round(min(values), 2),
        "maximum": round(max(values), 2),
    }


def summarize(
    path: Path,
    *,
    skip_first: int = 0,
    take_windows: int | None = None,
    min_windows: int = 1,
) -> dict[str, Any]:
    windows = parse_windows(path)
    if not windows:
        raise ValueError(f"{path}: no telemetry5s windows")
    if skip_first < 0 or min_windows < 1:
        raise ValueError("skip_first must be >=0 and min_windows must be >=1")
    windows = windows[skip_first:]
    if take_windows is not None:
        if take_windows < 1:
            raise ValueError("take_windows must be >=1")
        windows = windows[:take_windows]
    if len(windows) < min_windows:
        raise ValueError(
            f"{path}: need at least {min_windows} complete telemetry windows, "
            f"got {len(windows)}"
        )

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
    parser.add_argument("--skip-first", type=int, default=0)
    parser.add_argument("--take-windows", type=int)
    parser.add_argument("--min-windows", type=int, default=1)
    args = parser.parse_args()
    result = {
        "channels": [
            summarize(
                path,
                skip_first=args.skip_first,
                take_windows=args.take_windows,
                min_windows=args.min_windows,
            )
            for path in args.logs
        ]
    }
    rendered = json.dumps(result, indent=2, sort_keys=True)
    if args.out:
        args.out.write_text(rendered + "\n", encoding="utf-8")
    else:
        print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
