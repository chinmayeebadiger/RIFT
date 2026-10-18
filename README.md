# Rift

Rift is an autonomous incident-recovery system. Given a failed application and
its authorised source, logs, and runtime evidence, Rift investigates the failure,
forms and ranks causal hypotheses, generates candidate patches, verifies those
patches in isolated environments, and presents an evidence-backed recovery
report.

This repository contains the project foundation, the Phase 0 architecture
contracts, the M1 intake implementation,
and a deliberately broken demo storefront. The dashboard loads the typed
in-memory incident list and incident details from the local API. The API also
validates and hashes untrusted incident manifests and imports them as
append-only evidence; autonomous investigation, patch execution, and
verification data are not enabled yet. The storefront in `demo/` is a safe
repair target for later investigate, reproduce, patch, and verify work without
external services or credentials.

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
```

`make test` runs the foundation checks, the frontend API-client suite, the API
route suite, and the demo website smoke/integration suite. After the
dependencies have been installed, the test commands are deterministic and do
not contact external services. Run `make typecheck` and `make build` before a
release. The demo's repair-target suite is intentionally failing on the
baseline so a bug is observable before it is fixed:

```sh
make demo-regression
```

It contains four deterministic regression tests, one for each seeded defect.
Run it again after a repair; it should become green without changing the test
expectations.

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

The current implementation is a read-only dashboard, so the highest-value
checks are:

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
- once recovery actions exist: baseline reproduction, patch authorization,
  isolation, timeout/cancellation, evidence provenance, verification semantics,
  and the human approval boundary described in
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
selection is the only M1 integration caveat. Investigation, patch generation,
sandbox execution, and recovery reporting remain out of scope for this slice.
The M2 architecture baseline now fixes additive snapshot, command, normalization,
timeline, hypothesis-citation, and investigation-result ports; specialist
implementations and runtime M2 validators remain follow-up work.
The Phase 3 architecture baseline now fixes additive expected-invariant,
diff-validation, model-proposal, patch-ranking, and patch-response shapes plus
the sibling patch ports; specialist patch implementations, runtime M3 response
validators, and HTTP routes remain follow-up work.
