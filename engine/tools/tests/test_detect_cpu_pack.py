#!/usr/bin/env python3
"""Contract tests for the CPU packing planner."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
PLANNER = ROOT / "engine" / "tools" / "detect-cpu-pack.py"


def topology(core_count: int = 6, smt: bool = True) -> dict[str, object]:
    cpus = []
    for core in range(core_count):
        cpus.append({"cpu": core, "core": core, "socket": 0, "node": 0})
        if smt:
            cpus.append({"cpu": core + core_count, "core": core, "socket": 0, "node": 0})
    return {
        "cpus": cpus,
        "l3_domains": [
            {"cpus": [0, 1, 2, 6, 7, 8] if smt else [0, 1, 2]},
            {"cpus": [3, 4, 5, 9, 10, 11] if smt else [3, 4, 5]},
        ],
    }


class DetectCpuPackTests(unittest.TestCase):
    def invoke(self, fixture: dict[str, object], *args: str) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as tmp:
            fixture_path = Path(tmp) / "topology.json"
            fixture_path.write_text(json.dumps(fixture), encoding="utf-8")
            return subprocess.run(
                [
                    sys.executable,
                    str(PLANNER),
                    "--topology-fixture",
                    str(fixture_path),
                    "--json",
                    *args,
                ],
                text=True,
                capture_output=True,
                check=False,
            )

    def test_sequential_3600_includes_smt_and_has_no_overlap(self) -> None:
        result = self.invoke(topology(), "--channels", "3", "--pack", "sequential")
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads(result.stdout)
        self.assertEqual(
            [channel["cpus"] for channel in plan["channels"]],
            ["0,6,1,7", "2,8,3,9", "4,10,5,11"],
        )
        self.assertFalse(plan["overlap"])
        self.assertEqual([channel["raster_threads"] for channel in plan["channels"]], [3, 3, 3])

    def test_ccx_prefers_two_local_channels_and_marks_straddle(self) -> None:
        result = self.invoke(topology(), "--channels", "3", "--pack", "ccx")
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads(result.stdout)
        self.assertEqual(
            [channel["cpus"] for channel in plan["channels"]],
            ["0,6,1,7", "3,9,4,10", "2,8,5,11"],
        )
        self.assertEqual(
            [channel["quality"] for channel in plan["channels"]],
            ["local", "local", "straddle"],
        )

    def test_capacity_shortfall_fails_loudly(self) -> None:
        result = self.invoke(topology(), "--channels", "3", "--house-cores", "1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("capacity", result.stderr.lower())

    def test_smt_off_uses_only_available_logical_cpus(self) -> None:
        result = self.invoke(topology(smt=False), "--channels", "3")
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads(result.stdout)
        self.assertEqual(
            [channel["cpus"] for channel in plan["channels"]],
            ["0,1", "2,3", "4,5"],
        )
        self.assertEqual([channel["raster_threads"] for channel in plan["channels"]], [1, 1, 1])


if __name__ == "__main__":
    unittest.main()
