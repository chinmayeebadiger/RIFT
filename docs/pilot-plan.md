# M6 pilot plan

**Document version:** M6-pilot-v1
**Status:** M6 implementation complete; pilot execution and named human
security sign-off remain explicit release records. The current Docker Scout
report has unresolved high-severity Debian findings, so pilot entry is blocked
pending remediation or an approved, time-bounded exception.
**Pilot owner:** control-plane owner with platform/security reviewer

The pilot demonstrates that the existing bounded recovery flow is safe and
operable under representative synthetic incidents. It does not expand Rift into
production deployment, multi-tenant service, autonomous repair, or unrestricted
repository/network access.

## Scope and exclusions

The pilot is limited to:

- one reviewed repository revision and one incident per run;
- the checked-in synthetic repair fixture and synthetic log/evidence bundles;
- explicitly allowed relative paths, commands, and a declared expected baseline
  failure signature;
- the deterministic fake model for offline runs, with any real provider treated
  as an untrusted optional adapter and separately approved;
- staged Docker verification using a locally available immutable image digest,
  network disabled, bounded resources, and disposable workspaces;
- evidence-backed reports that remain pending human approval;
- local API/integration use with an operator who owns the host.

The pilot excludes production credentials and logs, production endpoints,
deployment/merge/push, user working-tree mutation, unrestricted internet,
multi-repository repair, customer data, and any claim that a green isolated
check proves production safety.

## Entry criteria

The pilot owner may start only when all of these are recorded:

1. M4/M5 tests are green from a clean checkout, including baseline-before-patch,
   path/command boundaries, timeout/cancellation, output limits, cleanup,
   report evidence, and human approval tests.
2. The exact repository revision, allowed paths, command allowlist, expected
   failure signature, timeout, evidence budget, and correlation-ID convention
   are reviewed for each scenario.
3. The staged runner composition is injected and its image is present locally
   at an immutable digest. The top-level build also uses a digest-pinned Node
   base image. A digest, Docker configuration, host prerequisites, and resource
   limits are attached to the pilot record.
4. No real credential or customer data is present in fixtures, environment,
   image layers, evidence, or operator notes. Secret rejection/redaction tests
   pass.
5. `make scan` passes, and the exact staged image digest has a separate
   registry-backed scan report meeting the policy in
   [`security-model.md`](security-model.md); absent image evidence blocks entry.
6. Operators can identify the run owner, platform cleanup owner, security
   escalation owner, and independent human approval reviewer.
7. The rollback/stop procedure in [`operator-runbook.md`](operator-runbook.md)
   has been walked through with the exact integration. The API exposes
   recovery status and cancellation routes but no pause endpoint; the owner
   must show the control-plane handle or document the stop/escalation path.
8. The security sign-off checklist below is complete, with residual risks
   explicitly accepted for the bounded pilot.

## Pilot scenarios

Run each scenario with synthetic IDs and retain the result and evidence hashes:

| Scenario | Expected outcome |
| --- | --- |
| Valid baseline reproduces the configured failure | Patch/check path runs; only an evidence-backed classification is produced |
| Baseline is green or signature differs | `not-reproduced`; no patch application |
| Candidate is out of scope or malformed | Validation failure; no checks or approval |
| Patched checks fail | `regressed`; candidate is rejected |
| Command blocks, times out, or is cancelled | `inconclusive`; cleanup still completes or escalates |
| Docker create/remove response is uncertain | `inconclusive`; owned-resource cleanup and escalation are demonstrated |
| Manifest is oversized, malformed, or secret-bearing | Intake rejects with a structured error and no accepted run |
| Concurrent bounded health/intake workload | Health remains responsive; observed concurrency never exceeds configured bound |
| Retention plan includes old and protected evidence | Dry-run is deterministic; explicit authorization returns a verifiable receipt and source remains append-only |
| Approval is attempted by a non-human or twice | Policy/error response; no mutation and no second decision |

## Exit metrics and evidence

Metrics are recorded per scenario and summarized for the pilot. Values below are
exit gates, not claims about current results.

| Metric | Exit gate | Evidence |
| --- | --- | --- |
| Unauthorized side effects | 0 working-tree, production, push, merge, deploy, or host-credential accesses | Audit/run review and host inspection |
| Secret leakage | 0 secrets in accepted evidence, model input, report, or escalation packet; rejected secret fixtures remain rejected | Redaction/secret fixture results and reviewer sample |
| Baseline correctness | 100% of scenarios requiring reproduction show baseline evidence and expected signature before patch | Run records and evidence hashes |
| Classification safety | 100% of timeout, cancel, blocked, missing-evidence, and cleanup-uncertain cases are `inconclusive`, never `verified` | Verification results |
| Cleanup | 100% of successful runs have confirmed workspace cleanup; every exception has an owner and escalation receipt | Runner cleanup receipts and host inspection |
| Scope enforcement | 100% of path/command/diff escape attempts are rejected | Boundary test output |
| Replayability | 100% of selected runs can resolve report citations, hashes, revision, plan, and command evidence | Replay worksheet |
| Approval boundary | 100% of decisions identify a validated human actor and no decision triggers a side effect | Approval records and audit review |
| Retention integrity | 100% of purge plans and receipts verify by hash; protected evidence remains in the source and retained view | Plan/receipt verification |
| Dependency/image posture | 100% of pilot inputs have current scan evidence with no unapproved blocking finding | Scan reports and digest record |
| Bounded reliability | No request error in the agreed synthetic workload; observed max in-flight does not exceed the configured limit | Reliability harness report |

Latency and throughput are reported as observations, not universal promises. The
pilot owner records workload, host, image digest, revision, and sample size so a
later target can be based on evidence rather than a wall-clock guess.

## Stop conditions

Stop the pilot immediately for a secret disclosure, unauthorized side effect,
runner escape suspicion, image/digest mismatch, missing cleanup, unexplained
audit/evidence loss, scan gate failure, or any attempt to treat `verified` as
approval. Follow the rollback/stop procedure, preserve the evidence, and open a
security issue or ADR before resuming.

## Exit review and follow-up

The pilot owner, implementation owner, and security reviewer jointly review the
metrics, failure packets, scan evidence, residual-risk register, and rollback
exercise. Exit is allowed only when all gates pass and each accepted residual
risk has an owner and follow-up issue. A failure remains an M6 open item; it is
not converted into a success by excluding the affected run.

## Explicit security sign-off checklist

- [ ] Scope is limited to synthetic, one-repository, one-incident runs with
      network disabled and no production mutation.
- [ ] Threat model, assets, trust boundaries, abuse cases, and residual risks in
      [`security-model.md`](security-model.md) were reviewed against the exact
      pilot composition.
- [ ] Manifest, evidence, patch, plan, report, and approval contracts validate;
      unsafe paths/commands, secret-bearing input, and oversized input are
      rejected.
- [ ] The exact runner image digest is approved, available locally, and scanned;
      dependency lockfiles and image scan records are attached.
- [ ] Resource, process, filesystem, network, output, timeout, cancellation,
      and cleanup controls were tested; no cleanup exception is unowned.
- [ ] Baseline-before-patch and fail-closed classification semantics were
      demonstrated for every negative scenario.
- [ ] Model/provider access is redaction-safe and cannot call tools, mutate the
      checkout, or authorize deployment.
- [ ] Human approval identity and decision recording are reviewed as an outer
      authentication responsibility; no approval path mutates production.
- [ ] Retention policy, dry-run review, explicit authorization, protected
      evidence, receipt verification, and current non-durable limitations are
      understood by the operator.
- [ ] Incident intake, cancel, cleanup, failure, escalation, and rollback steps
      were exercised with the exact integration.
- [ ] Exit metrics meet their gates, and every residual risk has an owner,
      acceptance decision, and follow-up issue/ADR.

**Decision:** `pending` until all boxes have evidence and named signers.

**Security reviewer:** ____________________  **Date:** __________

**Pilot owner:** __________________________  **Date:** __________
