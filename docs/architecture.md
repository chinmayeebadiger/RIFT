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

## Initial domain contracts

The first implementation should define versioned, serializable types for:

- `IncidentManifest`
- `EvidenceItem`
- `Hypothesis` and `HypothesisSet`
- `CandidatePatch`
- `VerificationPlan` and `VerificationResult`
- `RecoveryReport`
- `AuditEvent`

Every contract needs a stable ID, schema version, timestamps, content hashes,
and a correlation/incident ID. Schema changes must be additive or migrated.

## Operational qualities

- deterministic replay for all non-model steps;
- bounded concurrency per incident;
- idempotent retries keyed by content hash and stage;
- cancellation that terminates workers and destroys sandboxes;
- structured logs with no secrets;
- metrics for intake latency, hypothesis quality, patch verification rate,
  inconclusive runs, and sandbox failures.
