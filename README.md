# Rift

Rift is an autonomous incident-recovery system. Given a failed application and
its authorised source, logs, and runtime evidence, Rift investigates the failure,
forms and ranks causal hypotheses, generates candidate patches, verifies those
patches in isolated environments, and presents an evidence-backed recovery
report.

This repository contains the project foundation, the Phase 0 architecture
contracts, the M1 intake implementation, the Phase 2 investigation workers,
the Phase 3 patch/model boundaries, the Phase 4 isolated verification and
report/approval flow, and a deliberately broken demo storefront. The dashboard
loads the typed in-memory incident list, incident details, and recovery
report/approval state from the local API. Recovery reports are assembled only
from validated worker output and retain separate facts, inferences, unknowns,
citations, hypotheses, patches, commands, environment fingerprints, baseline
results, patched results, and final classification. The approval endpoint
records a human decision only; it never applies a patch, pushes a branch,
deploys, or calls production. The storefront in `demo/` is a safe repair target
for the offline integrated pipeline without external services or credentials.

## Project documents

- [Project foundation](docs/PROJECT_FOUNDATION.md) — goals, scope, principles,
  assumptions, and acceptance gates.
- [Architecture](docs/architecture.md) — components, data flow, trust
  boundaries, and proposed interfaces.
- [Shared contracts](docs/contracts.md) — fixed contract names and schema
  versioning strategy.
- [Ownership map](docs/ownership.md) — directory and boundary ownership.
- [Integration rules](docs/integration-rules.md) — rules for later sessions.
- [Architecture decisions](docs/adr/) — persistence, model, sandbox, and
  approval decisions.
- [Roadmap](docs/roadmap.md) — milestones, deliverables, and exit criteria.
- [Testing strategy](docs/testing-strategy.md) — test pyramid, fixtures,
  isolation tests, and reliability targets.
- [Documentation plan](docs/documentation-plan.md) — documentation sets and
  ownership expectations.
- [API reference](docs/api-reference.md) — local routes, request boundaries,
  recovery cancellation, reports, and approval semantics.
- [Recovery report guide](docs/recovery-report-guide.md) — how to review
  evidence, classifications, unknowns, and the approval boundary.
- [Contributor guide](docs/contributor-guide.md) — pinned toolchain, offline
  checks, fixture rules, and review checklist.

## Stack

- **Frontend:** Next.js App Router, TypeScript, Tailwind CSS, and local
  shadcn/ui-style primitives in `apps/web`.
- **Backend:** Node.js and TypeScript HTTP service in `services/api`.
- **Tests:** Vitest for JavaScript/TypeScript behavior and Python's standard
  library for the existing foundation contract checks.
- **AI:** GPT-6 Astra is the planned investigation and patch-generation
  provider. The skeleton does not call an AI provider or require credentials.

## Checks

Python 3.12 is pinned in `.python-version`, Node.js 20.11.1 is pinned in
`.nvmrc`, and each Node workspace has a committed `package-lock.json`.

```sh
make install
make test
make typecheck
make build
make scan
```

`make test` runs the foundation checks, the frontend API-client suite, the API
route suite, the demo website smoke/integration suite, and the repaired demo
regression suite. After the dependencies have been installed, the test
commands are deterministic and do not contact external services. Run
`make typecheck` and `make build` before a release. The demo's repair-target
suite covers the four seeded defects:

```sh
make demo-regression
```

It contains four deterministic regression tests, one for each seeded defect, and
is included in `make test`.

`make scan` runs `npm audit --offline --audit-level=high` against every committed
Node lockfile and checks the Dockerfile configuration without contacting a
registry or requiring a Docker daemon. The reproducibility check enforces the
exact Node version from `.nvmrc`, lockfile version 3, a multi-stage build, apt
cleanup, `npm ci`, secret-file exclusions, and a non-root runtime user.

### Integrated recovery pipeline

The composition API in `services/api/src/pipeline/` wires the complete bounded
flow:

```text
incident manifest intake
  -> append-only evidence
  -> pinned repository snapshot
  -> baseline reproduction (required)
  -> log/stack normalization and timeline
  -> cited hypotheses
  -> bounded candidate patch proposal and ranking
  -> disposable isolated verification
  -> evidence-backed recovery report
  -> pending human approval intent
```

`RecoveryPipeline` accepts explicit repository, command, model, runner, evidence,
and report-store capabilities. It does not infer authority from the process,
modify the caller's checkout, deploy a patch, or equate a green patched check
with approval. Candidate generation and isolated verification are skipped when
the actual baseline does not reproduce the configured failure signature.

For a local MVP, start the API in explicit demo mode:

```sh
RIFT_MVP_MODE=demo npm --prefix services/api run start
```

Then submit a server-owned demo recovery request:

```text
POST /api/incidents/:incidentId/recovery
```

The request accepts only `manifest`, `evidence`, and
`expectedBaselineFailure`. Repository paths, command capabilities, model
authority, runner image, and network policy are fixed by the server-side demo
composition. The response includes the generated incident, hypotheses,
candidate patches, report, and pending approval state. The API then serves the
same artifacts through the incident hypotheses, patches, report, and approval
routes. Normal mode fails closed unless a staged Docker pipeline is explicitly
injected/configured; it never silently falls back to host execution.

The deterministic end-to-end proof runs the real four-defect demo regression
suite red, applies a unified diff only in a disposable workspace, runs the same
suite green, persists separate evidence for both sides, and leaves the report
pending approval:

```sh
npm --prefix services/api test -- --run src/pipeline/recovery-pipeline.integration.test.ts
```

The test-only runner is explicitly injected and executes temporary copies. The
production composition point is `StagedDockerVerificationRunner`, which uses a
reviewed digest-pinned image, disabled network by default, bounded output, and
independent cleanup. Docker is not required for the offline test suite.

## Reproducible setup

Requirements: Python 3.12.x, Node.js 20.11.1, npm, `make`, and optionally
Docker. Dependencies are installed only inside the two Node workspaces.

```sh
make install
make dev
```

`make dev` starts both services. Open <http://localhost:3000> for the dashboard;
the API listens on port 4000.

The API exposes:

- `GET http://localhost:4000/health`
- `GET http://localhost:4000/api/incidents`
- `GET http://localhost:4000/api/incidents/RIFT-042`
- `GET http://localhost:4000/api/incidents/RIFT-042/report` — reads the
  evidence-backed report and approval state
- `POST http://localhost:4000/api/incidents/:incidentId/recovery` — runs the
  local demo MVP pipeline when `RIFT_MVP_MODE=demo` is enabled; accepts only
  server-validated manifest, evidence, and expected baseline signature fields
- `GET http://localhost:4000/api/recovery/:runId` and
  `POST http://localhost:4000/api/recovery/:runId/cancel` — inspect or request
  cancellation of a recovery run; cancellation preserves evidence and does not
  apply a patch
- `POST http://localhost:4000/api/reports` — validates and stores a report
  assembled from investigation, patch, verification, and evidence records
- `POST http://localhost:4000/api/reports/:reportId/approval` — records an
  explicit human approval or rejection intent; this is not a production action
- `POST http://localhost:4000/api/incidents/intake` — accepts a versioned JSON
  incident manifest and returns its deterministic content hash and evidence
  record. Invalid, oversized, unauthorized, unsafe, or secret-bearing input
  returns structured errors with a field path and stable error code.

### Broken demo website

Install and run the storefront separately:

```sh
npm --prefix demo ci
npm --prefix demo run start
```

Open <http://localhost:4173>. It is an intentionally small Rift Shop with
four repair targets documented in [`demo/BUG_CATALOGUE.md`](demo/BUG_CATALOGUE.md):

- cart quantities can become negative;
- the displayed discount is applied twice;
- an expired `WELCOME10` coupon is accepted; and
- searching for `hoodie` misses `Rift Hoodie` because matching is case-sensitive.

The smoke tests in `demo/src/domain/shop.test.ts` and
`demo/src/server.test.ts` prove the baseline is reachable. The correct-behavior
tests in `demo/src/domain/shop.regression.test.ts` are the automated
reproduction contract for repair work.

## Docker

The Dockerfile builds and verifies both workspaces. It runs the API by default:

```sh
docker build -t rift .
docker run --rm -p 4000:4000 rift
```

Run the built frontend instead:

```sh
docker run --rm -e RIFT_SERVICE=web -p 3000:3000 rift
```

Run the demo website from the image instead:

```sh
docker run --rm -e RIFT_SERVICE=demo -p 4173:4173 rift
```

Configuration placeholders are documented in `.env.example`. Never commit
credentials, production logs, source snapshots, or generated incident data.

## What needs testing next

The current implementation keeps the dashboard and approval flow local and
safe, so the highest-value checks are:

- frontend loading, empty, API failure, retry, incident selection, and detail
  rendering states;
- API health, incident list/detail responses, missing IDs, unsupported methods,
  and malformed or unavailable upstream responses;
- timeline and timestamp rendering at the UTC boundary, unknown status/stage
  values, and very long summaries or repository names;
- responsive layout and keyboard/screen-reader behavior for incident selection,
  retry, and navigation controls;
- end-to-end startup with the API rewrite (`make dev`), plus production build
  and Docker startup on a clean Linux machine;
- baseline reproduction, patch authorization, isolation, timeout/cancellation,
  evidence provenance, verification semantics, report replayability, and the
  human approval boundary described in
  [`docs/testing-strategy.md`](docs/testing-strategy.md).

The current Vitest setup covers the frontend API client and API routes. A real
browser component/e2e suite is still a follow-up gap; use the manual smoke flow
above until that is added.

## Status

Phase 0 architecture and contract gate complete. The shared `@rift/core`
package fixes the eight contract names and schema-version strategy; the four
ADRs fix persistence, model, sandbox, and approval policy. M1 deterministic
intake is complete against its roadmap exit criteria: versioned manifest,
deterministic validation, redaction and hashing utilities, local append-only
evidence storage, and the manifest intake API are implemented and covered by
offline tests. The default API test server remains in-memory; durable local
selection is the only M1 integration caveat. The integrated Phase 2–4 pipeline
now validates and composes pinned snapshots, actual baseline reproduction,
normalization, cited hypotheses, bounded patch proposals, isolated verification,
recovery reports, and the terminal human approval boundary. Verification keeps
baseline and patched evidence separate and rejects a `verified` result unless a
nonzero baseline reproduced first, the patched checks exited green, and both
sides have persisted evidence. M6 hardening is implemented with offline
dependency/Docker configuration scans, retention controls, bounded reliability
tests, threat-model documentation, an operator runbook, rollback guidance, and
  a pilot plan. The named human security sign-off and a current registry-backed
  scan of the exact staged image remain open external release gates; the
  current scan record is not a green sign-off. Durable orchestration,
  authenticated reviewer identity, and a browser/e2e suite remain residual work.
