import pathlib
import unittest


ROOT = pathlib.Path(__file__).parents[1]


class FoundationContractTests(unittest.TestCase):
    def test_required_foundation_files_exist(self):
        required = [
            "README.md",
            "Dockerfile",
            "Makefile",
            ".env.example",
            ".python-version",
            "pyproject.toml",
            "requirements.lock",
            "docs/PROJECT_FOUNDATION.md",
            "docs/architecture.md",
            "docs/roadmap.md",
            "docs/testing-strategy.md",
            "docs/documentation-plan.md",
            "docs/contracts.md",
            "docs/ownership.md",
            "docs/integration-rules.md",
            "docs/adr/0001-local-append-only-evidence.md",
            "docs/adr/0002-model-adapter.md",
            "docs/adr/0003-docker-runner.md",
            "docs/adr/0004-human-approval-boundary.md",
            "packages/core/package.json",
            "packages/core/package-lock.json",
            "packages/core/src/index.d.ts",
            "packages/core/src/validators.js",
        ]
        missing = [path for path in required if not (ROOT / path).is_file()]
        self.assertEqual([], missing)

    def test_safety_and_evidence_contracts_are_documented(self):
        architecture = (ROOT / "docs/architecture.md").read_text()
        foundation = (ROOT / "docs/PROJECT_FOUNDATION.md").read_text()
        for phrase in ("human approval", "isolated", "audit", "secrets"):
            self.assertIn(phrase, (architecture + foundation).lower())

    def test_phase_zero_contract_gate_is_fixed(self):
        contracts = (ROOT / "docs/contracts.md").read_text()
        declarations = (ROOT / "packages/core/src/index.d.ts").read_text()
        for name in (
            "IncidentManifest",
            "EvidenceItem",
            "Hypothesis",
            "HypothesisSet",
            "CandidatePatch",
            "VerificationPlan",
            "VerificationResult",
            "RecoveryReport",
            "AuditEvent",
        ):
            self.assertIn(name, contracts)
            self.assertIn(name, declarations)
        self.assertIn("schemaVersion", contracts)
        self.assertIn("contentHash", contracts)

    def test_no_credentials_are_present_in_example_configuration(self):
        env = (ROOT / ".env.example").read_text()
        self.assertNotIn("sk-", env)
        self.assertNotIn("password=", env.lower())


if __name__ == "__main__":
    unittest.main()
