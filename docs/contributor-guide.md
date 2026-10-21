# Rift contributor guide

This guide is the smallest supported path for making a reproducible change to
the local MVP. Keep changes inside this repository, preserve the offline
boundary, and update the relevant documentation in the same change as a
contract or policy change.

## Supported toolchain

- Python **3.12.6**, pinned by `.python-version`.
- Node.js **20.11.1**, pinned by `.nvmrc`.
- npm lockfile version 3 in each workspace: `apps/web`, `services/api`,
  `demo`, and `packages/core`.
- Docker is optional for the offline test suite and required only when
  exercising the staged runner or building the image.

Do not install project dependencies globally. The repository has no runtime
Python dependencies; `requirements.lock` is retained as the reproducibility
input. Use the project's package managers and committed lockfiles.

## Clean checkout workflow

```sh
make install
make test
make typecheck
make build
make scan
```

`make test` is the required offline behavior gate. It runs the Python
foundation/documentation checks and the frontend, API, security, smoke, and
repaired demo-regression Vitest suites. `make typecheck`, `make build`, and
`make scan` are separate release checks. `make demo-regression` can run the
four repair-target tests independently.

For a local manual run:

```sh
make dev
```

The dashboard is at `http://localhost:3000`; the API is at
`http://localhost:4000`. `RIFT_MVP_MODE=demo` enables the deterministic local
recovery composition. The default API data directory is `reports/`; do not
commit generated reports, evidence, logs, or workspaces.

## Change and fixture rules

1. Preserve schema version `1`, content hashes, correlation IDs, explicit
   policies, and the human approval boundary unless a reviewed ADR changes
   them.
2. Use synthetic incidents, source, logs, credentials, and identifiers in
   fixtures and examples. A value that looks like a secret must be rejected,
   not merely redacted later.
3. Keep repository paths relative and commands explicitly allowlisted. Do not
   add a shell escape, host checkout mutation, deployment, push, or production
   integration to the MVP.
4. Keep new dependencies in the appropriate workspace `package.json`, run the
   package manager there, and commit the resulting `package-lock.json`.
5. Add focused offline tests for changed behavior. Update the roadmap,
   runbook, security model, pilot plan, or API/report guides when behavior or
   an acceptance gate changes.

## Review checklist

- [ ] `make test` passes from the checkout.
- [ ] Typecheck/build/scan results are recorded when relevant.
- [ ] No credentials, customer data, generated evidence, or absolute local
      paths were added.
- [ ] API and report behavior is documented with synthetic examples.
- [ ] Fail-closed, cancellation, cleanup, and approval semantics remain clear.
- [ ] Any unverified external gate remains explicitly open.
