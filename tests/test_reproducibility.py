from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CHECK = ROOT / "scripts" / "check_reproducibility.py"


class ReproducibilityCheckTests(unittest.TestCase):
    def run_check(self, root: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(CHECK), "--root", str(root)],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_repository_passes_offline_reproducibility_check(self) -> None:
        result = self.run_check(ROOT)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("reproducibility check passed", result.stdout)

    def test_runtime_must_not_run_as_root(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            fixture = Path(temporary_directory)
            for path in ("Dockerfile", ".dockerignore", ".nvmrc"):
                shutil.copy2(ROOT / path, fixture / path)
            for workspace in ("apps/web", "services/api", "demo", "packages/core"):
                destination = fixture / workspace
                destination.mkdir(parents=True)
                shutil.copy2(ROOT / workspace / "package.json", destination / "package.json")
                shutil.copy2(ROOT / workspace / "package-lock.json", destination / "package-lock.json")

            dockerfile = fixture / "Dockerfile"
            dockerfile.write_text(
                dockerfile.read_text(encoding="utf-8").replace("USER rift", "USER root"),
                encoding="utf-8",
            )
            result = self.run_check(fixture)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("non-root rift user", result.stderr)

    def test_runtime_must_include_local_core_package(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            fixture = Path(temporary_directory)
            for path in ("Dockerfile", ".dockerignore", ".nvmrc"):
                shutil.copy2(ROOT / path, fixture / path)
            for workspace in ("apps/web", "services/api", "demo", "packages/core"):
                destination = fixture / workspace
                destination.mkdir(parents=True)
                shutil.copy2(ROOT / workspace / "package.json", destination / "package.json")
                shutil.copy2(ROOT / workspace / "package-lock.json", destination / "package-lock.json")

            dockerfile = fixture / "Dockerfile"
            dockerfile.write_text(
                dockerfile.read_text(encoding="utf-8").replace(
                    "COPY --from=build --chown=rift:rift /app/packages/core ./packages/core\n", ""
                ),
                encoding="utf-8",
            )
            result = self.run_check(fixture)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("@rift/core package", result.stderr)


if __name__ == "__main__":
    unittest.main()
