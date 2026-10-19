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

## M2 — Baseline reproduction and investigation (complete)

Deliverables: repository snapshot adapter, log/stack-trace normalization,
timeline, deterministic hypothesis engine, and evidence citations.

Exit criteria met: the M2 Rift Shop fixture is read from a pinned Git revision,
its baseline failure is reproduced through a bounded command executor, logs and
stack traces are normalized into a deterministic timeline, and ranked
hypotheses cite retained evidence while separating facts, inferences, and
unknowns. Covered by `services/api/src/m2-fixture.integration.test.ts` and the
normalization and hypothesis-engine suites.

## M3 — Candidate patch generation (complete)

Deliverables: patch contract, diff validation, bounded model adapter, fake model
for offline tests, and patch ranking.

Exit criteria met: malformed, oversized, out-of-scope, protected-path, and
base-revision-mismatched diffs are rejected; bounded provider output is
validated; the deterministic fake model produces offline candidates; and every
accepted patch has rationale, touched paths, an expected invariant, source
hypothesis, and pinned base revision. Covered by the shared contract,
model-adapter, patch-ranking, and integrated recovery suites.

## M4 — Isolated verification (complete)

Deliverables: runner interface, disposable Docker runner, command allowlist,
timeouts/resource limits, baseline-versus-patch comparison, and evidence
capture.

Exit criteria met: passing and failing fixtures are distinguished, and sandbox
escape, network, timeout, cancellation, output-limit, and cleanup boundaries
are covered by offline runner and orchestration tests.

## M5 — Recovery report and approval workflow (complete)

Deliverables: evidence-backed report, audit events, human approval boundary, and
CLI/local UI output.

Exit criteria met: reports retain facts, inferences, unknowns, citations,
hypotheses, patches, command results, and baseline-versus-patched evidence; a
reviewer can replay the claim from those records; and the approval endpoint
records human intent without applying, merging, pushing, or deploying changes.

## M6 — Hardening and pilot

Deliverables: threat-model review, dependency and image scanning, load/failure
tests, retention controls, operational runbook, and a limited pilot.

Exit criteria: security sign-off, documented residual risks, rollback procedure,
and observed reliability targets from representative incidents.
