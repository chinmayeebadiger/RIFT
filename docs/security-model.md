# Rift security model

**Document version:** M6-security-v1
**Status:** M6 implementation complete; pilot sign-off remains an explicit
human review record
**Scope:** M4 isolated verification and M5 recovery reports/approval, plus the
M6 controls that must be demonstrated before a pilot exit

This document describes the security boundary that exists today. A statement in
the **M6 gate** column is a requirement or an open item, not a claim that the
control is already deployed.

## Security objective

Rift may ingest a bounded incident, investigate it, propose a candidate patch,
and verify that patch in a disposable workspace. It must not turn an untrusted
incident, model response, repository, test command, or report into authority to
modify a user's checkout, production, or infrastructure. `verified` means only
that the configured baseline reproduced the expected failure and the patched
checks passed in the isolated run.

The security invariants are:

1. Input, worker output, and provider output are validated before use.
2. Repository paths, commands, patch scope, time, output, and concurrency are
   explicitly bounded.
3. Candidate execution is isolated and network-disabled by default.
4. Evidence is content-addressed, redacted before model access, and retained
   with provenance suitable for replay.
5. Cancellation, timeout, policy denial, and cleanup uncertainty fail closed.
6. A report or human approval record never deploys, pushes, merges, or applies a
   patch to the caller's checkout.

## Assets and security properties

| Asset | Required property | Current owner/boundary |
| --- | --- | --- |
| Incident manifest and log bundle | Authenticity of the supplied bytes, bounded size, no secret-bearing input | Intake and evidence store |
| Repository snapshot and revision | Read-only access to the authorized paths and exact revision | Repository capability and snapshot adapter |
| Candidate patch and verification plan | Integrity, scope, context, and idempotency | Shared validators and control plane |
| Evidence, report, and approval record | Integrity, provenance, correlation, replayability, and redaction state | Evidence/report stores |
| Runner image and installed dependencies | Reviewed, reproducible contents and known vulnerability state | Platform/security review; M6 scan gate |
| Host, Docker daemon, and local workspace | No escape, credential access, or unintended writes | Docker runner and host operator |
| Human approval identity | Correct attribution and explicit decision | Report API format; authentication remains external |
| Availability and cleanup capacity | Bounded resource use and removal of disposable workspaces | Orchestrator, runner, and operator |

## Trust boundaries

1. **Caller to intake:** HTTP JSON is untrusted. The API bounds the request,
   rejects malformed/unknown fields, unsafe paths and commands, and rejects
   detected secret-bearing values. The authorization signal in the local API is
   not an identity provider.
2. **Intake to evidence store:** normalized contracts and SHA-256 content hashes
   are checked before append. `LocalEvidenceStore` is append-only and fails
   closed on corrupt startup data; the default local API uses it under
   `RIFT_DATA_DIR` while tests may inject an in-memory store.
3. **Evidence to model adapter:** only redaction-safe content may cross this
   boundary. The current model adapter rejects secret-bearing input and the
   `LocalEvidenceStore` exposes redacted model views; this is not a promise that
   every arbitrary caller has already redacted its own text. The model is an untrusted
   proposal source with no tool, filesystem, deployment, or production
   capability.
4. **Repository capability to worker:** the worker receives an explicit revision
   and allowed paths, not arbitrary host path authority.
5. **Control plane to runner:** a validated plan is the only execution request.
   Runner output is untrusted until the control plane validates it and resolves
   its evidence IDs.
6. **Runner container to host:** source is transferred as an archive; the
   staged Docker runner does not mount the working tree, host credentials, or
   Docker socket. The container is read-only apart from bounded tmpfs paths.
7. **Report to human approval:** a report is evidence for review. The current
   approval endpoint records a human decision but has no production mutation
   path and does not provide authentication itself.
8. **Local filesystem to operator:** local evidence, reports, temporary archives,
   Docker metadata, and logs may contain sensitive incident context. Host file
   permissions, disk encryption, backups, and access control remain operator
   responsibilities.

## Threat model and controls

| Threat or abuse case | Impact | Control present in M4/M5 | M6 gate or residual risk |
| --- | --- | --- | --- |
| Oversized or malformed manifest | Resource exhaustion or parser confusion | 256 KiB intake limit, JSON/schema validation, closed-world contracts | Exercise concurrent malformed/oversized traffic; no general rate limiter is present |
| Secret in a manifest or imported log | Credential disclosure to storage, model, or report | Intake secret scan; recursive redaction; model-safe evidence; capture limits and configured-value redaction | Detection is pattern-based, not a guarantee; add secret fixtures and review false negatives |
| Path traversal or protected-path patch | Source disclosure or unauthorized change | Relative-path validation, allowed-path capabilities, `.git` rejection, diff validation | Review every pilot path and test symlink/archive edge cases |
| Shell injection or command expansion | Arbitrary host/container execution | Single-executable allowlist; forbidden shell syntax/flags; command and argument validation | Allowlist changes require review; allowed tools remain hostile code |
| Malicious repository/test code | Container escape or host impact | Staged runner uses pinned digest, `--pull never`, non-root UID, read-only root, dropped capabilities, no-new-privileges, no network, pids/memory/CPU/ulimit/tmpfs bounds, no host mount | Docker is not a VM; host/daemon compromise and kernel vulnerabilities remain residual risks |
| Model returns a dangerous or out-of-scope diff | Bad patch or misleading report | Model output is validated, bounded, ranked, and applied only in a disposable workspace | Provider prompt/data handling and model correctness need pilot evidence; no model is an authority |
| Baseline is green or signature differs | False claim of a verified repair | Baseline runs first; signature and evidence are required; result becomes `not-reproduced` or `inconclusive` | Representative fixture coverage and replay measurements are M6 work |
| Timeout, cancellation, or lost Docker response | Orphan process/container or false success | Abort signals, bounded process capture, cancellation state, independent cleanup, uncertain patch is not retried | A cleanup failure may leave a resource; operator escalation and host inspection are required |
| Replay or evidence tampering | Incorrect incident conclusion | Canonical hashes, append-only JSONL stores, immutable IDs, evidence-linked reports | Multi-process durability, locking, and durable centralized audit remain open |
| Approval spoofing or accidental deployment | Unauthorized production change | Approval is human-only in the contract; no push/merge/deploy/working-tree mutation exists | Current API actor headers/body are not authentication; integrate identity before any broader use |
| Retention removes needed evidence | Loss of investigation history | M6 retention helper uses a signed-by-hash dry-run plan, explicit actor authorization, and logical filtering without rewriting the source | The helper is not scheduled or durable in the API; define policy and persist receipts before pilot exit |
| Vulnerable dependency or image | Supply-chain compromise | Lockfiles are checked in; `make scan` performs offline npm audit checks and Docker configuration checks; staged image must be digest-pinned | A registry-backed CVE scan of the exact staged image still requires an operator/tooling outside this repository; pilot is blocked until that evidence exists |

## Implemented control inventory

The following are observable in the current code and tests:

- Intake rejects malformed, oversized, unauthorized, unsafe-path, unsafe-command,
  and detected secret-bearing inputs.
- Contracts use schema version `1`, closed-world validation, correlation IDs, and
  content hashes. The local JSONL store validates every existing record at
  startup and has no update/delete operation.
- The staged runner archives only the authorized paths from a pinned revision and
  creates a disposable, non-root, networkless container. It does not pull an
  image at run time. The older Docker runner also enforces disposable execution,
  but does not replace review of the staged composition.
- Baseline evidence is required before patch application. Verification evidence
  is bounded and redacted; missing evidence, failed checks, blocked commands,
  timeout, cancellation, or cleanup failure cannot become `verified`.
- Orchestration bounds concurrency, uses stage idempotency keys, records stage
  transitions/audit events through its injected sink, and cleans up in a final
  path. The demo composition intentionally uses a no-op audit sink for its local
  fixture; that is not a durable audit deployment.
- Reports remain approval-pending and the approval implementation only records an
  approved/rejected human decision. It has no code path to deployment or working-
  tree mutation.
- `RetentionManager` can produce a deterministic dry-run plan and an authorized,
  hash-verifiable receipt while exposing a logical retained view. It does not
  rewrite the append-only store.
- `make scan` passes the four local offline npm audits and the Dockerfile
  reproducibility check. The latest successful Docker Scout scan of the built
  image composition reported eight unresolved high-severity Debian findings in
  `util-linux`, `zlib`, and `perl` with no fixed versions reported by Scout.
  A repeat scan of the final image digest was blocked by local disk exhaustion;
  the prior result remains pilot-blocking evidence, not a green security
  sign-off.

## Secret handling policy

- Do not submit credentials, customer data, private keys, access tokens, or
  production logs in a fixture, manifest, issue, report, or documentation
  example. Use synthetic values such as `SYNTHETIC_TOKEN` only when a test needs
  a marker.
- Intake rejects secret-bearing values; it does not accept a secret and promise
  to remove it later. A rejected request should be discarded by the caller.
- The redaction pass recursively masks sensitive fields and known patterns such
  as private keys, connection strings, bearer values, common access keys,
  provider tokens, JWT-shaped values, and credential assignments. Runner output
  also masks configured values and sensitive environment values before evidence
  persistence.
- `.env.example` documents names only. Real values belong in an untracked local
  environment or an external secret manager; the current repository does not
  provide a secret manager, rotation service, or encrypted evidence store.
- Never put a secret in a command argument, image layer, Dockerfile, patch,
  source fixture, or captured output. If exposure is suspected, stop the run,
  treat the evidence as compromised, rotate the credential outside Rift, and
  follow the incident escalation in [`operator-runbook.md`](operator-runbook.md).

## Dependency and image scan policy

This is an M6 pilot gate. The repository provides a deterministic offline
`make scan` check for dependency audit data available in the local npm cache and
Dockerfile/reproducibility policy. Security sign-off still requires the pilot
record to attach the exact image-digest scan evidence.

1. Scan every checked-in npm lockfile (`apps/web`, `services/api`, `demo`, and
   `packages/core`) with the repository-approved offline-capable dependency
   scanner. Scan the Python lock input when Python dependencies are used.
2. Scan the exact runtime and build images used by the pilot. The staged runner
   configuration must use an immutable `registry/name@sha256:<digest>` image and
   `--pull never`; record the digest and scanner report together. The top-level
   Dockerfile also pins its Node base image by digest, while the digest must
   still be recorded with the scanner output for the pilot composition.
3. Block a pilot on any known critical or high vulnerability with a reachable
   path, an unreviewed image finding, a lockfile drift, or an unverified image
   digest. A documented, time-bounded exception requires the security owner,
   affected asset, exploitability rationale, compensating control, expiry, and
   rollback owner.
4. Re-run scans when a lockfile, base image, runner image, Dockerfile, install
   step, or security-relevant runtime dependency changes. Store only synthetic
   report metadata in this repository; do not commit scanner credentials or
   private registry output.

The repository's `make scan` target is the local scan entry point. A green unit
test run is not a substitute for `make scan`, and a green configuration check is
not a substitute for a registry-backed CVE report for the exact staged image.

## Residual risks and non-goals

- The local API is not an authenticated multi-tenant service. Header/body actor
  fields are input validation, not proof of identity.
- Test compositions may use in-memory evidence and report stores; those records
  disappear on process restart. The default local API selects append-only JSONL
  evidence and report stores under `RIFT_DATA_DIR` (default `./reports`), but
  this remains single-process local persistence rather than centralized audit.
- The current retention state and receipts are process-local unless an outer
  integration persists them. There is no scheduler, backup policy, or automatic
  legal hold implementation.
- Pattern redaction can miss an undiscovered secret format and can leave derived
  metadata, timing, or source context sensitive. It is defense in depth, not a
  license to ingest secrets.
- Docker isolation depends on the host kernel, daemon, image provenance, and
  operator configuration. A compromised host or daemon is outside Rift's
  control. A stronger VM/rootless backend is not present in this slice.
- Network-disabled verification prevents ordinary egress, but it does not prove
  production behavior and does not replace host network controls.
- There is no production deployment integration, rollback executor, durable
  centralized audit service, or registry-backed image scanner in this release.

## Security sign-off checklist

The security owner records each item as **pass**, **fail**, or **not applicable**
with evidence links. Any fail or unexplained N/A blocks pilot exit.

- [ ] Threat model and trust boundaries reviewed against the exact pilot
      composition and authorized paths.
- [ ] All pilot fixtures, manifests, logs, reports, and examples are synthetic;
      secret-scan negative and positive tests are attached.
- [ ] Intake limits, schema validation, path/command allowlists, and patch scope
      are tested at the HTTP and worker boundaries.
- [ ] The exact runner image digest, Docker flags, host prerequisites, and
      dependency lockfiles are recorded.
- [ ] Dependency and image scans meet the severity policy; exceptions, if any,
      have an owner and expiry.
- [ ] Network, filesystem, process, memory, CPU, output, timeout, cancellation,
      and cleanup tests pass for the pilot composition.
- [ ] Baseline-before-patch, evidence completeness, and fail-closed result
      classifications are demonstrated for every pilot scenario.
- [ ] Human approval is verified as an audit decision only, with no deployment,
      push, merge, or working-tree mutation path.
- [ ] Retention dry-run, explicit authorization, hash verification, protected
      evidence, and receipt handling are reviewed; durable retention ownership is
      documented.
- [ ] Incident intake, cancel, cleanup, failure, escalation, and rollback steps
      have an on-call owner and a tested stop condition.
- [ ] Residual risks are accepted by the security owner and pilot owner, with a
      follow-up issue/ADR for each risk that must be closed after M6.
