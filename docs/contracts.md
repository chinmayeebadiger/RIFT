# Shared contract reference

The canonical TypeScript declarations and runtime validators are in
[`packages/core/src/index.d.ts`](../packages/core/src/index.d.ts) and
[`packages/core/src/validators.js`](../packages/core/src/validators.js). API
code may temporarily import through its compatibility files, but new code
should import from `@rift/core`. The web app already consumes the shared
`IncidentId` type.

## Contract envelope

Every persisted or exchanged contract has:

```text
kind, schemaVersion, id, incidentId, correlationId, createdAt, contentHash
```

`schemaVersion` is the integer `1` for this release. `contentHash` is a
`sha256:<lowercase-hex>` value over the canonical JSON payload with
`contentHash` omitted. Timestamps are canonical UTC strings with millisecond
precision (`YYYY-MM-DDTHH:mm:ss.sssZ`). IDs are bounded, non-empty ASCII tokens.

## Fixed contract names

| Contract | Purpose | Producer | Consumer |
| --- | --- | --- | --- |
| `IncidentManifest` | bounded incident input and policy | intake client | control plane |
| `EvidenceItem` | immutable observation with provenance | intake/workers | all stages |
| `Hypothesis` | one causal explanation and next check | investigation | patch/report |
| `HypothesisSet` | ranked hypotheses for one run | investigation | patch/report |
| `CandidatePatch` | content-addressed proposed diff | patch worker | verifier/reviewer |
| `VerificationPlan` | allowlisted baseline and patch checks | control plane | runner |
| `VerificationResult` | observed baseline-versus-patch outcome | runner | report/audit |
| `RecoveryReport` | evidence-backed facts, inferences, unknowns | report stage | human reviewer |
| `AuditEvent` | policy/action receipt | every boundary | operators/review |
| `RepositorySnapshot` | immutable pinned source manifest | snapshot adapter | investigation/control plane |
| `CommandExecution` | bounded command outcome and evidence links | command adapter | investigation/report |
| `LogNormalization` | normalized log and stack observations | normalizer | timeline/investigation |
| `InvestigationTimeline` | deterministic ordered observations | timeline builder | hypothesis/report |
| `InvestigationResult` | evidence-backed M2 investigation outcome | investigation assembly | report/control plane |

Phase 3 adds the following additive value and transport shapes without changing
the schema version: `ExpectedInvariant`, `DiffValidationIssue`,
`DiffValidationResult`, `PatchModelProposal`, `PatchRankingEntry`,
`PatchRanking`, `PatchGenerationResponse`, and `PatchApiErrorResponse`.
`CandidatePatch.expectedInvariantDetails` is optional; its existing required
`expectedInvariant` statement remains the version-1 compatibility field.

These shapes are prepared for the patch boundary and are not persisted or
served by an API route in the architecture baseline. Before that happens,
shared runtime validators and JSON-round-trip fixtures must be added. Contextual
diff policy (base revision, allowed paths, and derived touched paths) belongs
to the `DiffValidator` port rather than the structural `CandidatePatch`
validator.

## Versioning strategy

1. A validator rejects an unknown `schemaVersion`; it never guesses.
2. Version 1 is closed-world at each object level: unknown keys are rejected.
3. Additive changes require a new optional field plus a compatibility test; a
   field becomes required only in a new major schema version or after an
   explicit migration.
4. Breaking changes create `schemaVersion: 2`, a migration/replay adapter, and
   an ADR. Old readers must continue to read retained version-1 evidence.
5. Hashes are computed after normalization and before persistence. A migration
   creates a new record with a new hash and retains the source hash in
   provenance; it never edits the old record.
6. Contract fixtures are synthetic, JSON-round-trippable, and checked in with
   validator tests. Every boundary treats input as `unknown` until validated.

M2 adds `EvidenceCitation` and `HypothesisEvidence` value shapes for replayable
locations and relationships. They do not alter the closed-world `Hypothesis`
contract; structured citations are carried by the M2 investigation result until
the shared validators are extended with M2 fixtures.

## Meaning of verified

`verified` means only that the configured baseline reproduced the incident and
the patched disposable workspace passed the configured checks. It does not
mean production safety, approval, or deployment authorization. A blocked,
timed-out, cancelled, or insufficiently evidenced run is `inconclusive`.
