# Rift

Rift is an autonomous incident-recovery system. Given a failed application and
its authorised source, logs, and runtime evidence, Rift investigates the failure,
forms and ranks causal hypotheses, generates candidate patches, verifies those
patches in isolated environments, and presents an evidence-backed recovery
report.

This repository contains the project foundation, a working application
skeleton, and a deliberately broken demo storefront. The current UI uses static
demo data while the API exposes typed in-memory incident records; autonomous
investigation and patch execution are not enabled yet. The storefront in
`demo/` is a safe repair target for testing the full investigate, reproduce,
patch, and verify loop without external services or credentials.

## Project documents

- [Project foundation](docs/PROJECT_FOUNDATION.md) — goals, scope, principles,
  assumptions, and acceptance gates.
- [Architecture](docs/architecture.md) — components, data flow, trust
  boundaries, and proposed interfaces.
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

`make test` runs the foundation checks, both existing Vitest suites, and the
demo website smoke/integration suite. After the dependencies have been
installed, the test commands are deterministic and do not contact external
services. The demo's repair-target suite is intentionally failing on the
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

The API skeleton exposes:

- `GET http://localhost:4000/health`
- `GET http://localhost:4000/api/incidents`
- `GET http://localhost:4000/api/incidents/RIFT-042`

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

## Status

Skeleton phase. The next implementation step is the domain model and
incident-evidence manifest described in Milestone 1 of the roadmap.
