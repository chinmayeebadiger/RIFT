# Directory ownership map

| Path | Owns | Must not own |
| --- | --- | --- |
| `packages/core/` | versioned wire types, schema constants, runtime validators, contract fixtures | HTTP, filesystem, provider SDKs, Docker, UI policy |
| `services/api/` | local API, intake orchestration, evidence persistence adapters, audit sink | model prompts, UI-only types, production mutation |
| `apps/web/` | read-only local dashboard and presentation state | contract definitions, evidence writes, approval execution |
| `demo/` | synthetic repair target and its tests | real credentials, production integrations |
| `tests/fixtures/` | synthetic incidents and expected deterministic results | customer data, secrets, generated workspace evidence |
| `docs/adr/` | accepted architectural decisions and their consequences | implementation-specific scratch notes |
| `docs/` | public contracts, safety rules, runbooks, roadmap, test strategy | credentials or private incident payloads |

## Boundary ownership

- **Control plane:** validates all external and worker input, evaluates policy,
  schedules bounded work, correlates hashes, and emits audit events.
- **Workers:** perform one bounded task and return typed, untrusted results;
  they do not call each other or bypass the control plane.
- **Evidence store:** owns append-only durability and immutable retrieval; it
  does not interpret hypotheses or execute commands.
- **Model adapter:** owns provider transport and redaction-safe serialization;
  it cannot access tools or production.
- **Sandbox runner:** owns disposable execution and cleanup; it cannot mount the
  user's checkout or return an unvalidated success.
- **Web app:** reads API results and never becomes an alternate policy engine.
