from __future__ import annotations

import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class DocumentationConsistencyTests(unittest.TestCase):
    def test_shipping_guides_are_present_and_linked(self) -> None:
        required = (
            "docs/api-reference.md",
            "docs/contributor-guide.md",
            "docs/recovery-report-guide.md",
        )
        for path in required:
            self.assertTrue((ROOT / path).is_file(), path)

        plan = (ROOT / "docs/documentation-plan.md").read_text(encoding="utf-8")
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        for path in required:
            self.assertIn(path, plan + readme)

    def test_docs_match_current_cancellation_and_release_gate_status(self) -> None:
        runbook = (ROOT / "docs/operator-runbook.md").read_text(encoding="utf-8")
        pilot = (ROOT / "docs/pilot-plan.md").read_text(encoding="utf-8")
        security = (ROOT / "docs/security-model.md").read_text(encoding="utf-8")

        self.assertIn("POST /api/recovery/<runId>/cancel", runbook)
        self.assertNotIn("current HTTP API does not expose a cancel route", runbook)
        self.assertIn("no pause endpoint", pilot.lower())
        self.assertIn("named human security sign-off", pilot.lower() + security.lower())
        self.assertIn("registry-backed", security.lower())
        self.assertIn("remain", security.lower())

    def test_shipping_commands_cover_repaired_demo_and_durable_runtime_config(self) -> None:
        makefile = (ROOT / "Makefile").read_text(encoding="utf-8")
        env_example = (ROOT / ".env.example").read_text(encoding="utf-8")
        self.assertIn("test: test-foundation test-web test-api test-security test-demo demo-regression", makefile)
        self.assertIn("RIFT_DATA_DIR=./reports", env_example)


if __name__ == "__main__":
    unittest.main()
