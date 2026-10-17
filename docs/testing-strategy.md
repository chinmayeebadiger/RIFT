# Rift testing strategy

## Test pyramid

1. **Unit tests:** parsers, redaction, hashing, schema validation, ranking,
   policy decisions, diff boundaries, and report classification.
2. **Property and fuzz tests:** malformed manifests, log encodings, huge lines,
   patch paths, Unicode, and untrusted model output.
3. **Component tests:** evidence store, orchestrator retries, model adapter,
   runner adapter, and audit sink using local fakes.
4. **Integration tests:** real repository fixture through intake, investigation,
   patch, verification, and report.
5. **Isolation/security tests:** filesystem escape, network access, process
   limits, secret leakage, symlink traversal, cleanup, and cancellation.
6. **Operational tests:** replay, idempotency, crash recovery, bounded
   concurrency, retention, and observability.

## Golden incident fixtures

Keep small, synthetic fixtures in the repository. Each fixture must include a
baseline revision, logs, expected failure signature, allowed commands, and an
expected report classification. Fixtures must not contain real credentials,
customer data, or proprietary source.

## Verification semantics

The verifier must run the baseline first. A patch can be labelled:

- **verified:** baseline reproduces the incident and patched checks pass;
- **regressed:** patched checks introduce a failure or violate an invariant;
- **not reproduced:** baseline did not demonstrate the incident;
- **inconclusive:** execution was blocked, timed out, or evidence was
  insufficient.

“Verified” is never inferred from an LLM response or from a green test suite
when the baseline failure was not reproduced.

## Required checks per change

The single developer entry point is `make test`; it must remain offline-capable.
As implementation begins, it should invoke the repository's unit, integration,
type, lint, and security checks without requiring network access. CI may run
additional image and dependency scans. A check that cannot run locally must be
labelled as such rather than replaced with a no-op.

## Repair-target demo

The repository includes an offline Rift Shop under `demo/`. It is intentionally
broken and provides a repeatable target for incident investigation exercises.
`make test` runs its green smoke and HTTP integration tests so the website is
known to start and respond. `make demo-regression` runs the four correct-
behavior tests that are expected to fail on the baseline and become green as
the defects are repaired. The suite uses fixed inputs and timestamps, so each
failure is reproducible on a clean machine.

## Reliability targets to establish during M6

Measure before committing targets. Proposed metrics are: deterministic replay
rate, evidence citation completeness, baseline reproduction rate, verified-fix
precision, inconclusive rate, sandbox cleanup success, and time-to-report.
