#!/usr/bin/env python3
"""Unit tests for doc04 DeckLink telemetry aggregation."""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
PARSER = ROOT / "engine" / "research" / "p19" / "parse_doc04_telemetry.py"

spec = importlib.util.spec_from_file_location("parse_doc04_telemetry", PARSER)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ParseDoc04TelemetryTests(unittest.TestCase):
    def test_aggregates_windows_and_detects_unlock(self) -> None:
        log = """
telemetry5s in_fps=29.0 out_fps=25.0 queue=0 d_pairs=21 d_singles=104 d_starved=0 d_late=0 d_dropped=0 d_flushed=0 d_overwritten=0 ref=locked | totals
telemetry5s in_fps=31.0 out_fps=25.0 queue=0 d_pairs=31 d_singles=94 d_starved=1 d_late=0 d_dropped=0 d_flushed=0 d_overwritten=0 ref=locked | totals
telemetry5s in_fps=28.0 out_fps=25.0 queue=0 d_pairs=10 d_singles=115 d_starved=0 d_late=1 d_dropped=0 d_flushed=0 d_overwritten=0 ref=UNLOCKED | totals
"""
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "channel.log"
            path.write_text(log, encoding="utf-8")
            report = module.summarize(path)

        self.assertEqual(report["windows"], 3)
        self.assertEqual(report["in_fps"]["median"], 29.0)
        self.assertEqual(report["in_fps"]["minimum"], 28.0)
        self.assertEqual(report["d_late_sum"], 1)
        self.assertEqual(report["ref_unlock_windows"], 1)
        self.assertEqual(report["d_pairs"]["average"], 20.67)

    def test_rejects_log_without_telemetry(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "channel.log"
            path.write_text("started low_latency=yes", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "telemetry5s"):
                module.summarize(path)


if __name__ == "__main__":
    unittest.main()
