# Rift implementation roadmap

Each milestone ends with a demonstrable slice, documentation updates, and a
green offline test command. No milestone permits production mutation unless a
later security review explicitly changes that boundary.

## M0 — Foundation and contracts (complete)

Deliverables: repository reproducibility, architecture, shared `@rift/core`
contracts and validators, four decision ADRs, ownership map, integration rules,
testing strategy, documentation plan, and safety principles.

Exit criteria: `make test` works offline and reviewers can name the incident
manifest, evidence provenance, sandbox boundary, contract version strategy, and
meaning of “verified”.

## M1 — Deterministic incident intake (complete)

Deliverables: versioned manifest, local evidence store, redaction pipeline,
content hashing, and CLI/API validation errors.

Exit criteria met: the synthetic fixture is ingested twice with identical
hashes; malformed, oversized, unauthorised, unsafe-path, and secret-bearing
inputs are covered by deterministic tests. The durable `LocalEvidenceStore` is
implemented and tested, while the API's default test server intentionally uses
`InMemoryEvidenceStore`; selecting a durable path for a local production-like
run remains follow-up integration work.

## M2 — Baseline reproduction and investigation

Deliverables: repository snapshot adapter, log/stack-trace normalization,
timeline, deterministic hypothesis engine, and evidence citations.

Exit criteria: a known fixture failure reproduces; the report names supporting
evidence and clearly marks uncertainty.

## M3 — Candidate patch generation

Deliverables: patch contract, diff validation, bounded model adapter, fake model
for offline tests, and patch ranking.

Exit criteria: invalid/out-of-scope patches are rejected; every accepted patch
has rationale, touched paths, and an expected invariant.

## M4 — Isolated verification

Deliverables: runner interface, disposable Docker runner, command allowlist,
timeouts/resource limits, baseline-versus-patch comparison, and evidence
capture.

Exit criteria: a passing and failing fixture are distinguished; sandbox escape,
network, timeout, cancellation, and cleanup tests pass.

## M5 — Recovery report and approval workflow

Deliverables: evidence-backed report, audit events, human approval boundary, and
CLI/local UI output.

Exit criteria: a reviewer can reproduce the claim from the report without
trusting hidden agent state; no production action occurs without approval.

## M6 — Hardening and pilot

Deliverables: threat-model review, dependency and image scanning, load/failure
tests, retention controls, operational runbook, and a limited pilot.

Exit criteria: security sign-off, documented residual risks, rollback procedure,
and observed reliability targets from representative incidents.
