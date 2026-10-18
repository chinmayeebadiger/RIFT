# M2 investigation architecture baseline

This document fixes the additive interfaces for baseline reproduction and
investigation. It deliberately does not implement a repository adapter, command
runner, log parser, timeline builder, hypothesis engine, or result assembler.

## Scope

M2 connects the existing M1 manifest and append-only evidence items to a
replayable investigation result:

```text
IncidentManifest + policy
        |
        v
RepositorySnapshotReader -- pinned, allowlisted source view
        |
        v
CommandExecutor -- bounded reproduction and diagnostic commands
        |
        v
LogNormalizer -- normalized records with source citations
        |
        v
TimelineBuilder -- deterministic sequence
        |
        v
HypothesisEngine -- ranked existing HypothesisSet shape
        |
        v
InvestigationResultAssembler -- facts, inferences, unknowns, citations
```

The ports are declared in
[`services/api/src/investigation/ports.ts`](../services/api/src/investigation/ports.ts).
The serializable M2 shapes are additive declarations in
[`packages/core/src/index.d.ts`](../packages/core/src/index.d.ts). Existing M1
contracts remain unchanged and retain `schemaVersion: 1`; M2 is a milestone,
not a new wire version.

## Interface rules

- `RepositorySnapshotReader` receives a repository, pinned revision, and
  allowlisted relative paths through `RepositoryReadCapability`. It may not read
  the user's working tree, secrets, or network.
- `CommandExecutor` receives one existing `CommandSpec` and an explicit
  `CommandExecutionCapability`. It returns an untrusted result and must classify
  failure, timeout, cancellation, and policy denial without treating them as
  success.
- `LogNormalizer` accepts evidence already imported by M1 plus its decoded text.
  It must preserve source evidence IDs and may not delete or rewrite evidence.
- `TimelineBuilder` receives observations and owns only stable ordering and
  timeline grouping. Equal or missing timestamps require deterministic tie
  breaking; no ambient clock or random ordering is permitted.
- `HypothesisEngine` consumes validated snapshot, execution, normalization,
  timeline, and evidence inputs. It returns an untrusted proposal that cites
  evidence and cannot invoke tools, write files, generate patches, or approve
  changes.
- `InvestigationResultAssembler` links all intermediate IDs and emits facts,
  inferences, and unknowns. Missing evidence or broken references are
  inconclusive/fail-closed conditions.

All port methods return `Promise<unknown>` intentionally. Worker and adapter
outputs cross a trust boundary; the control plane must runtime-validate the
corresponding `@rift/core` contract before using or persisting them. Ports do not
call one another, mutate shared state, or bypass the control plane.

## Contract additions

`@rift/core` now declares these additive M2 shapes:

- `RepositorySnapshot` and `RepositorySnapshotFile`;
- `CommandExecution` and `CommandExecutionStatus`;
- `LogNormalization`, `NormalizedLogRecord`, and stack-frame values;
- `EvidenceCitation` and `HypothesisEvidence`;
- `InvestigationTimeline` and `InvestigationTimelineEvent`;
- `InvestigationResult` and its status;
- stable IDs for each new persisted shape.

The existing `Hypothesis` and `HypothesisSet` contracts remain the canonical
hypothesis output. `HypothesisEvidence` supplies structured citations without
silently changing the closed-world M1 hypothesis validator.

## Integration requirements

1. Import wire types from `@rift/core`; do not create duplicate specialist
   interfaces for these names.
2. Add runtime validators and compatibility fixtures before any M2 result is
   persisted or exposed over HTTP.
3. Validate every adapter/worker result as `unknown` at the control-plane
   boundary and verify that referenced evidence exists in the append-only store.
4. Hash normalized persisted representations after redaction/normalization and
   retain source hashes and locators for replay.
5. Keep commands single-stage, allowlisted, bounded, cancellable, and offline in
   tests. Do not introduce Docker, provider calls, patch generation, or approval
   behavior in this baseline.
6. Each specialist owns only its reserved implementation file and adjacent
   tests, as defined in [`ownership.md`](ownership.md). Shared contracts,
   `ports.ts`, and barrel exports are integration-owned.
7. Integration must add boundary tests for malformed worker output, unknown
   keys/schema versions, path escapes, missing citations, timeout/cancellation,
   deterministic ordering, and JSON round trips.
