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

## M2 integration file ownership

The M2 baseline defines ports and serializable shapes only. Specialist work must
implement the reserved files below and must not edit another specialist's file,
the shared contract declarations, or the port definitions without an integration
review.

| File or path | Owner | Specialist boundary |
| --- | --- | --- |
| `packages/core/src/index.d.ts` | integration/contracts owner | additive M2 wire types, IDs, citations, and result shapes; no adapters or orchestration |
| `services/api/src/investigation/ports.ts` | integration owner | stable adapter ports, capability inputs, and trust-boundary comments; no specialist logic |
| `services/api/src/investigation/index.ts` | integration owner | investigation boundary exports only |
| `services/api/src/investigation/repository-snapshot.ts` | repository snapshot specialist | implements `RepositorySnapshotReader`; no command execution or normalization |
| `services/api/src/investigation/command-executor.ts` | command execution specialist | implements `CommandExecutor`; no repository reads outside the supplied snapshot/capability |
| `services/api/src/investigation/log-normalizer.ts` | log normalization specialist | implements `LogNormalizer`; preserves source evidence and does not rank hypotheses |
| `services/api/src/investigation/timeline-builder.ts` | timeline specialist | implements `TimelineBuilder`; deterministic ordering only |
| `services/api/src/investigation/hypothesis-engine.ts` | hypothesis specialist | implements `HypothesisEngine`; no tool calls or patch generation |
| `services/api/src/investigation/result-assembler.ts` | investigation integration specialist | implements `InvestigationResultAssembler`; validates references and assembles the result |
| `services/api/src/investigation/**/*.test.ts` | matching specialist | tests only the adjacent port implementation; shared contract tests remain integration-owned |
| `docs/m2-architecture.md` | architecture/integration owner | port semantics, sequencing, and integration requirements |

Shared contract changes are additive and coordinated by the integration owner.
If a specialist needs a new field, it must propose the field and its validator or
fixture impact rather than adding a private interface with the same meaning.

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
