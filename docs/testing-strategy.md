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

## Current dashboard checks

The initial dashboard is read-only and consumes the API's incident list and
detail routes. Until browser automation is introduced, every dashboard change
should cover:

1. **API-client unit tests:** successful list/detail responses, URL-encoded
   incident IDs, non-2xx JSON errors, and non-JSON upstream errors.
2. **API integration tests:** health, list, detail, missing incident, and
   unsupported method responses.
3. **Manual browser smoke:** start the API and Next.js app with `make dev`,
   confirm the list loads, select each incident, reload, and confirm loading,
   empty, and retryable failure states are understandable.
4. **Build checks:** `make typecheck` and `make build`, including the Docker
   build when deployment files change.
5. **Accessibility/responsive review:** keyboard selection and retry, visible
   focus states, screen-reader labels, narrow viewport layout, and long text.

The UI currently presents recovery, patch, and verification areas as product
surface only; those areas must not be treated as proof that autonomous recovery
has run. When those actions become connected, add end-to-end tests for the
approval and verification boundaries before enabling them.

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
