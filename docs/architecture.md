# Rift architecture

## System shape

Rift is an orchestrated, evidence-producing pipeline rather than an agent with
unbounded permissions:

```text
Incident source
      |
      v
Intake -> Evidence store -> Investigation -> Patch synthesis
                                  |                  |
                                  v                  v
                           Hypothesis set     Isolated verifier
                                  \                  /
                                   v                v
                                  Evidence-backed report
                                           |
                                           v
                                  Human approval gate
```

The control plane owns orchestration and policy. Workers perform bounded work
and return typed results. The evidence store is append-only for a run.

## Core components

### 1. Intake and manifest

Validates an `IncidentManifest`: incident ID, repository revision, allowed
paths, log sources, reproduction command, test commands, time window, and
policy. Intake rejects oversized, malformed, or unauthorised inputs and records
hashes for every imported artifact.

### 2. Evidence store

Stores immutable evidence items with content hash, source, timestamps, redaction
status, and provenance. Logs are normalized but the original artifact remains
available subject to policy. Secrets are redacted before model access and are
never included in generated reports.

### 3. Investigation engine

Builds a timeline, extracts failure signatures, searches the repository at the
pinned revision, and emits a ranked `HypothesisSet`. Each hypothesis contains
supporting and contradicting evidence, confidence, assumptions, and the next
discriminating check. The engine may use an LLM, but the LLM output is an
untrusted proposal and cannot execute tools directly.

### 4. Patch synthesizer

Turns a selected hypothesis into one or more candidate patches. A patch is a
content-addressed diff with touched paths, rationale, expected invariant, and
generation metadata. It cannot be applied to the user's working tree by the
first release.

### 5. Isolated verifier

Creates a fresh workspace from the pinned revision, applies exactly one patch,
and runs an allowlisted command plan. Network is disabled unless an explicit
policy permits a documented dependency mirror. Resource, time, filesystem, and
process limits are enforced. The result captures exit codes, stdout/stderr
hashes, test summaries, changed files, and environment fingerprints.

### 6. Report and approval boundary

Combines investigation and verification into a report that distinguishes facts,
inferences, and unknowns. A verified result means the baseline reproduced the
incident and the patched workspace passed the configured regression checks; it
does not mean production safety is proven. Production application remains a
human approval action.

### 7. Audit and policy layer

Records actor, policy decision, tool, input hashes, output hashes, timestamps,
and failures for every side effect. Policy is evaluated before source access,
model calls, sandbox creation, and any external action.

## Trust boundaries

1. **External incident inputs -> intake:** untrusted; validate and redact.
2. **Model/tool proposals -> control plane:** untrusted; schema-validate and
   authorize independently.
3. **Verifier -> host:** hostile code; use disposable isolation and resource
   limits.
4. **Rift -> production:** prohibited by default; only an explicit approval
   flow can cross this boundary.

## Shared contract package

The fixed wire contracts live in `packages/core/` and are published locally as
`@rift/core`. It owns the serializable TypeScript declarations, schema
constants, and runtime validators. The API keeps compatibility re-exports while
callers migrate; the web app consumes shared ID types rather than redefining
them. The package has no HTTP, filesystem, provider, Docker, or UI dependency.

The contract set is:

- `IncidentManifest`
- `EvidenceItem`
- `Hypothesis` and `HypothesisSet`
- `CandidatePatch`
- `VerificationPlan` and `VerificationResult`
- `RecoveryReport`
- `AuditEvent`
- `RepositorySnapshot`, `CommandExecution`, and `LogNormalization`
- `InvestigationTimeline` and `InvestigationResult`

Every contract has a stable ID, schema version, timestamps, content hash, and
incident/correlation IDs. Version 1 is closed-world and rejects unknown keys;
additive changes require compatibility tests, while breaking changes create a
new schema version and migration. See [`contracts.md`](contracts.md).

The M2 adapter ports are integration-owned in
`services/api/src/investigation/ports.ts`. They accept explicit capabilities and
return untrusted worker output for control-plane validation; specialist
implementations are reserved by [`docs/ownership.md`](ownership.md).

The M3 patch boundary is intentionally a sibling in
`services/api/src/patch/ports.ts`. It consumes validated M2 outputs and keeps
model proposals, contextual diff validation, candidate assembly, ranking, and
future patch API responses separate. All patch worker results remain untrusted;
candidate generation cannot apply a patch, run verification, or satisfy human
approval.

## Phase 0 decisions

The architecture gate is closed: persistence is local append-only JSONL,
provider access is behind an untrusted model adapter with a deterministic fake,
verification is behind a Docker-first runner interface, and all production or
working-tree mutation remains explicitly human-controlled. The full decisions
are recorded in [`docs/adr/`](adr/).

## Operational qualities

- deterministic replay for all non-model steps;
- bounded concurrency per incident;
- idempotent retries keyed by content hash and stage;
- cancellation that terminates workers and destroys sandboxes;
- structured logs with no secrets;
- metrics for intake latency, hypothesis quality, patch verification rate,
  inconclusive runs, and sandbox failures.
