# Rift

Rift is an autonomous incident-recovery system. Given a failed application and
its authorised source, logs, and runtime evidence, Rift investigates the failure,
forms and ranks causal hypotheses, generates candidate patches, verifies those
patches in isolated environments, and presents an evidence-backed recovery
report.

This repository currently contains the project foundation and implementation
plan. Product implementation deliberately starts only after the contracts and
safety boundaries in `docs/` have been reviewed.

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

## Current foundation checks

The foundation uses Python's standard library only. Python 3.12 is pinned in
`.python-version`; the dependency lockfile is `requirements.lock`. No application runtime has been
implemented yet.

```sh
make test
```

The check is intentionally offline and validates the repository's foundation
documents and required safety statements. It is not a substitute for the
future application test suite.

## Reproducible setup

Requirements: Python 3.12.x, `make`, and optionally Docker. No global Python
packages are required.

```sh
python3 -m venv .venv
. .venv/bin/activate
make test
```

The container recipe runs the same check:

```sh
docker build -t rift-foundation .
docker run --rm rift-foundation
```

Configuration placeholders are documented in `.env.example`. Never commit
credentials, production logs, source snapshots, or generated incident data.

## Status

Planning/foundation phase. The next implementation step is the domain model and
incident-evidence manifest described in Milestone 1 of the roadmap.
