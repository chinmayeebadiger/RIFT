#!/usr/bin/env python3
"""Check the repository's offline dependency and container reproducibility rules."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


WORKSPACES = ("apps/web", "services/api", "demo", "packages/core")
BASE_IMAGE_PATTERN = re.compile(
    r"^node:(?P<version>\d+\.\d+\.\d+)-bookworm-slim@sha256:(?P<digest>[0-9a-f]{64})$"
)
FROM_PATTERN = re.compile(r"^FROM\s+(\S+)(?:\s+AS\s+(\S+))?\s*$", re.IGNORECASE)


def check(root: Path) -> list[str]:
    errors: list[str] = []

    nvmrc = root / ".nvmrc"
    if not nvmrc.is_file():
        errors.append(".nvmrc is required")
        node_version = None
    else:
        node_version = nvmrc.read_text(encoding="utf-8").strip()
        if not re.fullmatch(r"\d+\.\d+\.\d+", node_version):
            errors.append(".nvmrc must contain an exact Node.js version")

    dockerfile = root / "Dockerfile"
    dockerfile_text = dockerfile.read_text(encoding="utf-8") if dockerfile.is_file() else ""
    if not dockerfile_text:
        errors.append("Dockerfile is required")

    stages: list[tuple[str, str | None]] = []
    for line in dockerfile_text.splitlines():
        match = FROM_PATTERN.match(line.strip())
        if match:
            stages.append((match.group(1), match.group(2)))

    if len(stages) < 2:
        errors.append("Dockerfile must use separate build and runtime stages")
    if not any(stage == "build" for _, stage in stages):
        errors.append("Dockerfile must define a build stage")
    if not any(stage == "runtime" for _, stage in stages):
        errors.append("Dockerfile must define a runtime stage")

    for image, _ in stages:
        match = BASE_IMAGE_PATTERN.fullmatch(image)
        if not match:
            errors.append(f"base image {image!r} must be an exact versioned, digest-pinned bookworm-slim Node.js image")
        elif node_version and match.group("version") != node_version:
            errors.append(f"base image {image!r} must match .nvmrc Node version ({node_version})")

    runtime_start = next(
        (index for index, (_, stage) in enumerate(stages) if stage == "runtime"),
        None,
    )
    runtime_text = ""
    if runtime_start is not None:
        from_lines = [
            index for index, line in enumerate(dockerfile_text.splitlines()) if FROM_PATTERN.match(line.strip())
        ]
        runtime_line = from_lines[runtime_start]
        runtime_text = "\n".join(dockerfile_text.splitlines()[runtime_line:])

    if not re.search(r"^USER\s+rift\s*$", runtime_text, re.MULTILINE):
        errors.append("runtime image must switch to the non-root rift user")
    if "useradd" not in runtime_text or "--uid 10001" not in runtime_text:
        errors.append("runtime image must create the pinned non-root uid 10001 user")
    if "--chown=rift:rift" not in runtime_text:
        errors.append("runtime application files must be owned by the non-root user")

    required_docker_hardening = (
        ("--no-install-recommends", "apt installs must avoid recommended packages"),
        ("rm -rf /var/lib/apt/lists", "apt package lists must be removed"),
        (r"npm(?:\s+--prefix\s+\S+)?\s+ci\b", "dependencies must be installed from lockfiles with npm ci"),
        ("NODE_ENV=production", "runtime must set NODE_ENV=production"),
    )
    for needle, message in required_docker_hardening:
        found = re.search(needle, dockerfile_text) if needle.startswith("npm") else needle in dockerfile_text
        if not found:
            errors.append(message)

    if re.search(r"^\s*ADD\s", dockerfile_text, re.MULTILINE | re.IGNORECASE):
        errors.append("Dockerfile must use COPY instead of ADD")
    if re.search(r"^\s*COPY\s+(?:--[^ ]+\s+)*\.(?:env|npmrc)(?:\s|$)", dockerfile_text, re.MULTILINE):
        errors.append("Dockerfile must not copy secret-bearing environment or npm config files")
    if not re.search(r"^\s*COPY\s+--from=build\s+(?:--[^ ]+\s+)*?/app/packages/core\s+", dockerfile_text, re.MULTILINE):
        errors.append("runtime image must include the local @rift/core package")

    dockerignore = root / ".dockerignore"
    ignored = {
        line.strip()
        for line in dockerignore.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    } if dockerignore.is_file() else set()
    for pattern in (".env", ".env.*", "!.env.example", "*.npmrc", "*.pem", "*.key"):
        if pattern not in ignored:
            errors.append(f".dockerignore must exclude secret pattern {pattern}")

    for workspace in WORKSPACES:
        workspace_path = root / workspace
        package_json_path = workspace_path / "package.json"
        lockfile_path = workspace_path / "package-lock.json"
        if not package_json_path.is_file() or not lockfile_path.is_file():
            errors.append(f"{workspace} must contain package.json and package-lock.json")
            continue
        try:
            package = json.loads(package_json_path.read_text(encoding="utf-8"))
            lockfile = json.loads(lockfile_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            errors.append(f"{workspace} package metadata is not valid JSON: {error}")
            continue
        if lockfile.get("lockfileVersion") != 3:
            errors.append(f"{workspace}/package-lock.json must use lockfileVersion 3")
        root_package = lockfile.get("packages", {}).get("")
        if not isinstance(root_package, dict) or root_package.get("name") != package.get("name"):
            errors.append(f"{workspace}/package-lock.json root package must match package.json")
        elif any(
            package.get(dependency_group, {}) != root_package.get(dependency_group, {})
            for dependency_group in ("dependencies", "devDependencies", "optionalDependencies")
        ):
            errors.append(f"{workspace}/package-lock.json dependencies must match package.json")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()

    errors = check(args.root.resolve())
    if errors:
        print("reproducibility check failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("reproducibility check passed: pinned Node image, lockfiles, non-root runtime, and Docker hardening")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
