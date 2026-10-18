# ADR 0002: Untrusted model adapter with a deterministic fake

- **Status:** Accepted
- **Date:** 2026-10-18
- **Owners:** Investigation / patch synthesis

## Context

Model output can be malformed, adversarial, incomplete, or nondeterministic.
Offline tests must be reproducible and must not require credentials or network
access. The control plane, not a model, must own tool access and policy.

## Decision

Define a provider-neutral model adapter in the control plane. The adapter
accepts a redaction-safe, hash-addressed input and returns `unknown`; its
boundary immediately parses JSON, validates the expected shared-core contract,
and rejects all extra or missing fields. Model output is a proposal only. It
cannot call tools, read the filesystem, create a sandbox, mutate a worktree, or
approve production action.

Offline tests use a deterministic fake model selected explicitly by the test
configuration. The fake is a pure function of a versioned input fixture and
returns stable `HypothesisSet` or `CandidatePatch` proposals. The real GPT-6
Astra/provider adapter is an implementation behind the same interface, enabled
only by an explicit provider configuration and policy decision. Provider names,
model IDs, prompts, input hashes, output hashes, and failures are recorded in
`AuditEvent`; secrets and raw unredacted evidence are never sent to the model.

## Consequences

- Provider choice does not leak into domain contracts or verification logic.
- Fake-model tests can exercise failure, invalid-output, and retry paths
  without network access.
- A provider adapter must handle rate limits, timeouts, retention, and provider
  errors without weakening schema validation.
- “The model said so” is never evidence of a verified fix.
