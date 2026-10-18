# Integration rules for later sessions

These rules are the Phase 0 gate. A later session may implement a component only
if it preserves them and adds tests at the boundary it changes.

1. **Contract first.** Cross-package data uses an `@rift/core` contract. Do not
   create a second local interface for a fixed contract name.
2. **Validate at every trust boundary.** Treat HTTP, filesystem, model, worker,
   runner, and provider output as `unknown`; validate before branching on it.
3. **Hash and correlate.** Persist canonical content hashes, stable incident and
   correlation IDs, and citations to evidence. Never cite an in-memory object
   that cannot be replayed.
4. **Fail closed.** Invalid input, missing evidence, policy denial, timeout,
   cancellation, and cleanup uncertainty are not success.
5. **No ambient authority.** Pass an explicit capability/policy object to an
   adapter. Do not read arbitrary paths, environment secrets, network, or the
   user's working tree from a worker.
6. **One stage, one interface.** The control plane owns orchestration. Workers
   return data; they do not mutate shared state or invoke production actions.
7. **Baseline before patch.** Verification must run the baseline first and keep
   baseline and patched evidence separate.
8. **Human approval is terminal.** Recovery reports and candidate patches are
   outputs for review. No code path may equate `verified` with approved.
9. **Offline determinism.** Unit and integration tests use the fake model,
   local evidence store, synthetic fixtures, and no external network. Real
   providers and Docker are opt-in integration checks.
10. **Reproducible changes.** Pin runtime/tool versions, update lockfiles, keep
    Docker and README instructions current, and run `make test` after each
    working step.
