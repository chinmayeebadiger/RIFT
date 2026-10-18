# ADR 0004: Human-controlled approval boundary

- **Status:** Accepted
- **Date:** 2026-10-18
- **Owners:** Control plane / security

## Context

Rift is allowed to ingest, investigate, generate candidate patches, and verify
them. It must not silently mutate a user's working tree or production. A green
test result is evidence about an isolated fixture, not authorization to deploy.

## Decision

Rift may write only to its own evidence, report, cache, and disposable sandbox
directories. It may create candidate patch artifacts and recovery reports, but
it must not apply a candidate patch to the user's checkout, push a branch,
merge, deploy, change infrastructure, or call production APIs.

Every policy-relevant attempt emits an `AuditEvent` before and after the action
where applicable. `RecoveryReport.approvalRequired` is always `true` in the
first-release contract. Any future production integration must be a separate,
explicitly invoked human approval workflow with a displayed diff, evidence
links, target/environment, rollback plan, and an auditable approver identity.
No model output, verification classification, retry, or automation may satisfy
that approval implicitly.

## Consequences

- The first release is safe to run against a real source snapshot only when the
  snapshot and evidence permissions are configured correctly.
- Users receive a candidate and evidence-backed recommendation, not an
  autonomous deployment.
- A future mutation capability requires a new ADR, threat-model review, and
  contract/version change rather than a flag added to the verifier.
