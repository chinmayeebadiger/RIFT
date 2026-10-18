# M3 candidate patch architecture baseline

This document fixes the additive Phase 3 interfaces for candidate patch
generation. It prepares the integration boundary only: specialist diff
parsers, provider adapters, fake-model behavior, ranking algorithms, HTTP
routes, patch application, and verification are not implemented here.

## Scope

M3 consumes the validated M2 hypothesis and pinned snapshot, then produces
untrusted candidate patches for later verification and human review:

```text
Hypothesis + snapshot + redacted evidence
                  |
                  v
           PatchModelAdapter -- provider-neutral, bounded, unknown output
                  |
                  v
           DiffValidator -- paths, base revision, diff shape, policy
                  |
                  v
           PatchGenerator -- validates and assembles candidates
                  |
                  v
           PatchRanker -- deterministic review ordering only
                  |
                  v
           PatchGenerationResponse -- API/wire shape for a later route
```

The shared declarations are in
[`packages/core/src/index.d.ts`](../packages/core/src/index.d.ts). The API
ports are in [`services/api/src/patch/ports.ts`](../services/api/src/patch/ports.ts)
and exported by its sibling barrel. The existing
[`investigation/ports.ts`](../services/api/src/investigation/ports.ts) remains
M2-only and its hypothesis engine does not generate patches.

## Additive contract decisions

- `CandidatePatch` remains the canonical Phase 2 payload and keeps
  `expectedInvariant: string` required for schema version 1 compatibility.
- `CandidatePatch.expectedInvariantDetails` is optional structured context;
  it cannot replace or reinterpret the required statement.
- `DiffValidationResult`, `PatchModelProposal`, `PatchRanking`, and
  `PatchGenerationResponse` are shared value/wire shapes. Their runtime
  validators belong in the contract/integration follow-up before persistence or
  HTTP exposure.
- `PatchApiErrorResponse` preserves the existing `{ error, code, errors }`
  response envelope while allowing optional field paths and messages.
- No new schema version is introduced. Version 1 remains closed-world for
  every object that is runtime-validated.

## Trust and sequencing rules

1. Every adapter or worker result is `unknown` until the control plane validates
   it against the appropriate shared shape.
2. Model input is redaction-safe, hash-addressed, explicitly allowlisted, and
   bounded. The model cannot read files, call tools, apply diffs, or approve a
   change.
3. Diff validation is contextual. It receives the pinned base revision and
   allowed paths, derives touched paths from the diff, and rejects path escapes,
   mismatches, unsupported changes, malformed/empty diffs, and oversized input.
4. Only validated candidates enter ranking. Ranking is run metadata; it does
   not mutate `CandidatePatch`, prove correctness, verify a patch, or approve it.
5. A later API route must validate its success and error response before
   serialization. This baseline adds no route and performs no patch mutation.
6. Verification remains a Phase 4 concern. Candidate patch generation never
   runs commands or treats a model score as evidence.

## Integration requirements

- Import shared wire types from `@rift/core`; do not create local replacements.
- Keep specialist implementation files separate from the ports:
  `diff-validator.ts`, `model-adapter.ts`, `fake-model.ts`,
  `patch-generator.ts`, and `patch-ranker.ts`.
- Use deterministic, offline fixtures for fake-model and boundary tests. Real
  providers are opt-in and must remain behind the same `PatchModelAdapter` port.
- Preserve `sourceHypothesisId`, base revision, content hashes, incident IDs,
  and correlation IDs through every stage.
- Add shared runtime validators and JSON-round-trip fixtures before any M3
  value is persisted or served over HTTP.
- Do not edit the M2 ports to add patch generation. If a cross-stage field is
  needed, propose it through the integration owner and update its validator and
  fixture impact together.

## Out of scope for this baseline

- unified-diff parsing or patch application;
- provider SDKs, prompts, credentials, network calls, or retries;
- deterministic fake-model proposal contents;
- ranking/scoring implementation;
- HTTP endpoint wiring and persistence;
- sandbox verification, deployment, merge, push, or working-tree mutation.
