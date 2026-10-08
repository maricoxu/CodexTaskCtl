"""Regression test for Capture Bar image paste wiring."""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


@unittest.skipUnless(sys.platform == "darwin" and shutil.which("swiftc"), "requires macOS Swift")
class CaptureBarMultimodalTests(unittest.TestCase):
    def test_self_test_covers_title_and_body_image_paste(self):
        repo = Path(__file__).resolve().parents[1]
        source = repo / "capture-bar/CodexTaskCtlCaptureBar.swift"
        with tempfile.TemporaryDirectory(prefix="codextaskctl-capture-test-") as directory:
            binary = Path(directory) / "CodexTaskCtlCaptureBar"
            subprocess.run(
                ["swiftc", str(source), "-o", str(binary), "-framework", "AppKit", "-framework", "Carbon"],
                check=True,
                capture_output=True,
                text=True,
            )
            result = subprocess.run(
                [str(binary), "--self-test"],
                check=True,
                capture_output=True,
                text=True,
                env={**os.environ, "NSUnbufferedIO": "YES"},
            )
            self.assertIn("Capture save contract passed", result.stdout)

    def test_source_exposes_per_image_delete_button(self):
        source = (Path(__file__).resolve().parents[1] / "capture-bar/CodexTaskCtlCaptureBar.swift").read_text()
        self.assertIn("removeImageAtPreview", source)
        self.assertIn("removeButton.tag = index", source)
        self.assertIn("removingImage(at: sender.tag", source)

    def test_immediate_button_is_a_save_and_dispatch_action(self):
        source = (Path(__file__).resolve().parents[1] / "capture-bar/CodexTaskCtlCaptureBar.swift").read_text()
        self.assertIn('NSButton(title: "保存并立即交给 Codex", target: self, action: #selector(saveAndDispatch))', source)
        self.assertIn("@objc private func saveAndDispatch()", source)
        self.assertNotIn("if dispatchImmediately {hideWindow()}", source)
        self.assertIn("process.arguments = [script.path, \"--queue-immediate\"", source)
        self.assertIn("process.terminationStatus == 0", source)
