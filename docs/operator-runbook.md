# Rift operator runbook

**Document version:** M6-operations-v1
**Status:** M6 implementation complete; pilot execution and named human
security sign-off remain explicit release records
**Operating mode:** local, bounded, one incident at a time; no production
mutation

This runbook is for the operator of a local Rift instance or an integration
that owns a `VerificationOrchestrator`. Examples use synthetic identifiers such
as `SYNTHETIC-INC-001`; replace them only with authorized incident data and do
not paste credentials into commands or reports.

## Before accepting a run

1. Confirm the repository revision, authorized relative paths, reproduction
   command, test commands, expected baseline failure code/signature, timeout,
   evidence budget, and network policy are recorded in the manifest.
2. Confirm the source is a synthetic fixture or an explicitly authorized source
   snapshot. Do not provide a caller-controlled repository path to the API.
3. For staged Docker verification, confirm the configured runner image is an
   approved immutable digest and is already available locally. The runner uses
   `--pull never`; a missing image must stop the run rather than trigger a pull.
4. Confirm network access is `disabled`, the command list is minimal, and no
   host checkout, Docker socket, host credential directory, or production
   endpoint is mounted or passed through.
5. Run `make scan` and retain its output. Confirm the exact staged image digest
   has a separate registry-backed scan report and that the security sign-off
   checklist exists for the pilot. The local configuration check cannot replace
   a CVE scan of the exact image.

The default API server is a local/demo composition. A production-like recovery
request is rejected until a staged Docker composition is injected; a test or
explicit demo mode uses deterministic in-process fixtures. Do not interpret the
demo path as proof that a staged container run occurred.

## Incident intake

The current local API accepts a JSON `IncidentManifest` at
`POST /api/incidents/intake`. The body is limited to 256 KiB. It normalizes
safe paths, validates schema version 1, checks policy and commands, scans for
secret-bearing values, hashes the manifest, and appends a manifest evidence
record.

For a synthetic intake, record the request/response pair in the operator log:

```text
incidentId: SYNTHETIC-INC-001
correlationId: SYNTHETIC-RUN-001
result: 201 / manifest accepted
manifestHash: sha256:<synthetic-fixture-hash>
```

Expected handling:

- `201`: retain the returned manifest hash and evidence ID; proceed only if the
  operator confirms scope and policy.
- `400`: correct the manifest. Do not retry unchanged malformed input.
- `403`: authorization or policy denial. Escalate if the denial is unexpected;
  do not weaken the manifest to make it pass.
- `413`: reduce the bundle or use a bounded synthetic fixture. Never bypass the
  limit by streaming unreviewed data.
- Secret-bearing input: discard the rejected request, rotate the exposed value
  outside Rift if it was real, and escalate as a potential secret incident.

The local API's `x-rift-authorization` handling is a local policy signal, not
authentication. Human identity and transport security must be supplied by the
outer deployment before handling sensitive incidents.

## Start and observe a run

1. Create or select a validated manifest and an expected failure signature.
2. Submit the recovery request only to the configured local API route:
   `POST /api/incidents/<incidentId>/recovery`.
3. Capture the response, report ID, manifest hash, candidate patch IDs,
   verification plan ID, and evidence IDs. Keep the correlation ID with every
   operator note.
4. Confirm the sequence is baseline, patch application in a disposable
   workspace, checks, classification, cleanup, and report generation. A report
   with `approval.status=pending` is expected.
5. Review facts, inferences, unknowns, citations, baseline evidence, patched
   evidence, touched paths, image/revision fingerprint, and failure codes before
   any human decision.

The verifier's useful terminal classifications are:

| Classification | Operator action |
| --- | --- |
| `verified` | Treat only as isolated evidence. Review and approve/reject the report; it is not deployment authorization. |
| `regressed` | Reject the candidate, preserve evidence, and open an investigation follow-up. |
| `not-reproduced` | Do not pursue the patch from this run; verify the revision, command, and expected signature. |
| `inconclusive` | Stop any further action, inspect the failure/cleanup evidence, and escalate when the cause is not local and clear. |

## Cancel a run

The control-plane interface exposes `VerificationOrchestrator.cancel(runId,
reason)`, which aborts the linked worker signal. The local HTTP API also exposes
`POST /api/recovery/<runId>/cancel`, incident-scoped cancel/stop routes, and
`DELETE /api/incidents/<incidentId>/recovery` as a cancellation alias. These
routes request cancellation and preserve evidence; they do not imply that a
patch was applied or safely undone. There is no pause endpoint. An integration
that cannot call either the control-plane handle or an HTTP cancellation route
must stop accepting new work and escalate rather than inventing an operation.

When cancellation is available:

1. Record the run ID, correlation ID, operator, reason, and time.
2. Call cancel once; do not retry patch application after a cancellation or
   uncertain transport response.
3. Wait for the run to reach `cancelled`/`inconclusive` and for cleanup to run.
4. Confirm no approval is recorded and preserve all evidence and transitions.
5. If cleanup is not confirmed within the configured cleanup timeout, follow
   **Cleanup failure** below and keep the run inconclusive.

Cancellation never deletes evidence and never means that a patch was safely
applied. A cancelled or uncertain patch must be treated as not applied to the
user's checkout, while the disposable workspace still requires cleanup proof.

## Cleanup procedure

Cleanup runs in the orchestrator's final path and uses a separate bounded
signal. The staged runner removes owned containers with force/volume cleanup,
removes its temporary directory, and includes allocations whose create response
was uncertain. The runner marks an uncertain cleanup as failure; the result
cannot be `verified`.

Operator steps:

1. Confirm the run reached `cleaning-up` and record the workspace IDs and result.
2. Confirm the runner returned `cleaned: true` (or equivalent) and its local
   temporary directory is gone.
3. If Docker is used, inspect only containers labeled
   `rift.verification=disposable` that belong to the run. Do not remove an
   unrelated container. If ownership is uncertain, isolate the host and
   escalate to the platform owner.
4. Preserve evidence, audit output, and the cleanup error. Do not edit the
   append-only evidence file to hide an orphan or failed run.
5. Mark the run `inconclusive` and block pilot continuation until the cleanup
   cause and remediation are recorded.

## Retention and cleanup of stored evidence

Retention is a logical operation over the append-only evidence source. The M6
`RetentionManager` workflow is:

1. Select a named policy and fixed `asOf` time; produce a deterministic dry-run
   plan with cutoff, protected IDs, purge IDs, content hashes, and plan hash.
2. A human or explicitly authorized retention actor reviews the plan. Missing
   `authorized: true` or a blank actor must fail.
3. Before execution, verify the source item IDs and hashes still match the plan.
4. Execute once with a reason and timestamp. Store and verify the returned
   receipt hash in the integration's audit system.
5. Serve the logical retained view and keep the append-only source unchanged.

The current helper keeps purge state and the receipt in process memory; the API
does not schedule retention or persist these receipts by itself. Until a durable
integration exists, an operator must not describe a logical purge as secure
deletion, compliance deletion, or a completed retention job.

Protect evidence needed for an active incident, pilot report, security review,
legal hold, or unresolved escalation. If a plan includes such evidence, stop
and regenerate the plan with an explicit protected rule.

## Failure handling and escalation

| Signal | Immediate action | Escalate to |
| --- | --- | --- |
| Invalid/oversized/unsafe intake | Stop retry loop; correct or discard input | Incident owner if unexpected; security owner for secret input |
| Baseline not reproduced or signature mismatch | Preserve baseline evidence; do not apply a patch | Service/repository owner |
| Patch validation or scope failure | Reject candidate; do not broaden allowed paths | Security owner and patch owner |
| Command blocked, timed out, or cancelled | Keep `inconclusive`; inspect command, limits, and signal | Platform owner if repeatable |
| Missing/corrupt evidence or audit failure | Stop classification and approval; preserve source | Data/control-plane owner |
| Cleanup failure or uncertain Docker create/remove | Isolate host, inspect only owned disposable resources, block new runs | Platform security owner |
| Secret appears in retained output | Stop sharing output, restrict access, rotate real credential externally | Security incident owner immediately |
| Unexpected approval or actor mismatch | Reject decision and preserve request/headers as incident evidence | Security owner |
| Dependency/image scan finding | Do not admit the image or pilot | Platform/security owner |

Escalation packet (synthetic values only in examples) must contain the incident
ID, correlation ID, run state/transitions, manifest and plan hashes, image digest,
failure code, evidence IDs/hashes, cleanup result, operator/time, and the exact
policy decision. Do not include raw secrets or unredacted logs in the packet.

## Rollback and stop procedure

Rift has no production deploy or working-tree mutation capability, so rollback
means stopping the recovery activity and restoring the surrounding integration
or runner configuration—not reverting a production change made by Rift.

1. Announce a pilot stop and stop admitting new recovery requests at the outer
   ingress or process supervisor. The current API has no pause endpoint.
2. Cancel every active orchestrator run where the integration exposes the
   control-plane handle. If it does not, stop the integration and escalate; do
   not kill containers without recording ownership.
3. Wait for cleanup receipts. For any uncertain workspace, isolate the host and
   have the platform owner inspect/remove only labeled disposable resources.
4. Mark affected runs `inconclusive`, preserve evidence, reports, approval state,
   and retention plans, and revoke any external access that was granted to the
   integration.
5. Roll the outer service back to the last reviewed application/configuration
   and the last approved immutable runner-image digest. Do not use the mutable
   `latest` tag or pull a replacement image during recovery.
6. Verify health, offline tests, scan evidence, and the security checklist
   before reopening the pilot. A new image, policy, path scope, or dependency
   requires a new review.

There is no Rift rollback command that can undo a production deployment. If an
external system was changed by a separate human action after report review, its
service owner must use that system's independently reviewed rollback plan.

## Operator closeout checklist

- [ ] Intake, run, approval state, cancellation (if any), and cleanup outcome
      are recorded by incident and correlation ID.
- [ ] Report classification is not confused with deployment authorization.
- [ ] Evidence and report hashes resolve; no raw secret is in the packet.
- [ ] Any timeout, blocked command, failed cleanup, or uncertain transport is
      classified inconclusive and escalated as required.
- [ ] Retention actions have a reviewed plan, explicit actor, verified receipt,
      and protected-evidence review.
- [ ] Pilot metrics and open residual risks are updated before the run is closed.
