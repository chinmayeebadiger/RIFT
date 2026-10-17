# Rift

Rift is an autonomous incident-recovery system. Given a failed application and
its authorised source, logs, and runtime evidence, Rift investigates the failure,
forms and ranks causal hypotheses, generates candidate patches, verifies those
patches in isolated environments, and presents an evidence-backed recovery
report.

This repository contains the project foundation and a working application
skeleton. The current UI uses static demo data while the API exposes typed
in-memory incident records; autonomous investigation and patch execution are
not enabled yet.

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

`make test` runs the foundation checks plus both Vitest suites. After the
dependencies have been installed, the test commands are deterministic and do
not contact external services.

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

Configuration placeholders are documented in `.env.example`. Never commit
credentials, production logs, source snapshots, or generated incident data.

## Status

Skeleton phase. The next implementation step is the domain model and
incident-evidence manifest described in Milestone 1 of the roadmap.
