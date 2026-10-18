# ADR 0003: Docker-first sandbox runner

- **Status:** Accepted
- **Date:** 2026-10-18
- **Owners:** Verification / platform security

## Context

Candidate patches and repository tests are hostile input from Rift's point of
view. They must not write to the user's working tree, access production, or
escape through network, paths, processes, or resources. A stronger isolation
backend may be needed later, so the verifier must not depend on Docker APIs in
its domain contracts.

## Decision

Define a `SandboxRunner` interface that accepts a validated `VerificationPlan`
and returns a validated `VerificationResult` plus captured evidence. The first
implementation is a disposable Docker container created from a pinned image,
with a fresh workspace, a read-only source snapshot, an isolated patch
application step, disabled network by default, an allowlisted command plan,
resource and timeout limits, and explicit cancellation/cleanup.

The runner never mounts the user's working tree, host credentials, Docker
socket, or production endpoints. Baseline execution occurs before the patch;
only a baseline reproduction followed by passing patched checks can produce
`verified`. Timeout, cancellation, blocked policy, cleanup failure, or missing
evidence produces `inconclusive` rather than success.

## Consequences

- Docker is a deployment/build dependency, not a contract dependency.
- Runner tests use a deterministic local fake; isolation tests run against the
  Docker adapter when Docker is available.
- Rootless/containerd/VM backends can implement the same interface later.
- The Docker image, command allowlist, and resource defaults are security
  configuration and require review when changed.
