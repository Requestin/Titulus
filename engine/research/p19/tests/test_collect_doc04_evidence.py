#!/usr/bin/env python3
"""Smoke tests for the non-invasive doc04 evidence collector."""

from __future__ import annotations

import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
COLLECTOR = ROOT / "engine" / "research" / "p19" / "collect-doc04-evidence.sh"


class CollectDoc04EvidenceTests(unittest.TestCase):
    def test_help_is_available_without_hardware(self) -> None:
        result = subprocess.run(
            ["bash", str(COLLECTOR), "--help"],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Exclusive, read-only", result.stdout)


if __name__ == "__main__":
    unittest.main()
