from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "parse_doc04_telemetry.py"
SPEC = importlib.util.spec_from_file_location("parse_doc04_telemetry", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def telemetry(in_fps: float, *, include_drop: bool = True) -> str:
    fields = (
        f"telemetry5s in_fps={in_fps} d_pairs=1 d_singles=2 "
        "d_starved=3 d_late=0 "
    )
    if include_drop:
        fields += "d_dropped=0 "
    return fields + "d_flushed=0 ref=locked\n"


class TelemetryParserTest(unittest.TestCase):
    def write_log(self, text: str) -> Path:
        handle = tempfile.NamedTemporaryFile("w", delete=False)
        with handle:
            handle.write(text)
        return Path(handle.name)

    def test_selects_only_complete_measurement_windows(self) -> None:
        path = self.write_log(
            telemetry(1.0) + telemetry(10.0) + telemetry(20.0) + telemetry(30.0)
        )
        report = MODULE.summarize(path, skip_first=1, take_windows=2, min_windows=2)
        self.assertEqual(report["windows"], 2)
        self.assertEqual(report["in_fps"]["median"], 15.0)

    def test_rejects_missing_required_counter(self) -> None:
        path = self.write_log(telemetry(10.0, include_drop=False))
        with self.assertRaisesRegex(ValueError, "missing telemetry fields"):
            MODULE.summarize(path)

    def test_rejects_short_measurement(self) -> None:
        path = self.write_log(telemetry(10.0))
        with self.assertRaisesRegex(ValueError, "need at least 2"):
            MODULE.summarize(path, min_windows=2)

    def test_aggregates_windows_and_detects_unlock(self) -> None:
        log = """
telemetry5s in_fps=29.0 d_pairs=21 d_singles=104 d_starved=0 d_late=0 d_dropped=0 d_flushed=0 ref=locked
telemetry5s in_fps=31.0 d_pairs=31 d_singles=94 d_starved=1 d_late=0 d_dropped=0 d_flushed=0 ref=locked
telemetry5s in_fps=28.0 d_pairs=10 d_singles=115 d_starved=0 d_late=1 d_dropped=0 d_flushed=0 ref=UNLOCKED
"""
        report = MODULE.summarize(self.write_log(log))
        self.assertEqual(report["windows"], 3)
        self.assertEqual(report["in_fps"]["median"], 29.0)
        self.assertEqual(report["d_late_sum"], 1)
        self.assertEqual(report["ref_unlock_windows"], 1)

    def test_rejects_log_without_telemetry(self) -> None:
        path = self.write_log("started low_latency=yes")
        with self.assertRaisesRegex(ValueError, "telemetry5s"):
            MODULE.summarize(path)


if __name__ == "__main__":
    unittest.main()
