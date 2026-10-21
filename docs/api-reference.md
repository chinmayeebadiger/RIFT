# Rift local API reference

The API is a local MVP service. It is not an authenticated multi-tenant API and
its actor headers are policy inputs, not proof of identity. Requests and
responses are JSON. Bodies are bounded to 256 KiB by the server. Examples use
synthetic values only.

Start it with:

```sh
RIFT_MVP_MODE=demo npm --prefix services/api run start
```

The default bind is `127.0.0.1:4000`; `RIFT_HOST=0.0.0.0` is intended for an
explicit container composition. The local API uses append-only JSONL evidence
and report stores under `${RIFT_DATA_DIR:-./reports}`. Tests may inject in-memory
stores and pipeline capabilities.

## Health and incidents

| Method and path | Result |
| --- | --- |
| `GET /health` | `{ service, status: "ok", version, timestamp }` |
| `GET /api/incidents` | Seeded demo incidents plus completed dynamic recovery incidents |
| `GET /api/incidents/:incidentId` | One incident, or `404` when the incident is unknown |
| `GET /api/incidents/:incidentId/hypotheses` | Hypothesis set for a known incident |
| `GET /api/incidents/:incidentId/patches` | Candidate patches for a known incident |

`POST /api/incidents/intake` accepts a version-1 `IncidentManifest`. It returns
`201` with `manifest`, `manifestHash`, and the manifest evidence record. The
server normalizes safe relative paths, rejects unknown/unsafe/secret-bearing
input, and returns structured `400`, `403`, or `413` errors. The optional
`x-rift-authorization: deny` header demonstrates policy denial; it is not an
authentication mechanism.

## Demo recovery

`POST /api/incidents/:incidentId/recovery` accepts exactly:

```json
{
  "manifest": { "schemaVersion": 1, "kind": "IncidentManifest" },
  "evidence": [],
  "expectedBaselineFailure": { "code": "CHECK_FAILED", "signature": "synthetic" }
}
```

The abbreviated example is illustrative; the manifest must satisfy the full
contract and use the server-owned demo paths, `node`/`npm` commands, and
`networkAccess: "disabled"`. In demo mode a successful `201` contains the
incident, manifest, hypothesis set, candidate patches, report record, and
`recoveryRunId`. Normal mode fails closed with `503` until an explicit staged
Docker image is configured. The request never supplies repository paths,
authority, image, or network policy.

Recovery status and cancellation are available through the control-plane
routes:

| Method and path | Result |
| --- | --- |
| `GET /api/recovery/:runId` | Current `running`, `completed`, `cancelled`, or `failed` status |
| `POST /api/recovery/:runId/cancel` | `202` cancellation requested for the run |
| `POST /api/incidents/:incidentId/recovery/:runId/cancel` | Incident-scoped cancellation |
| `POST /api/incidents/:incidentId/recovery/cancel` or `/stop` | Cancels the one running recovery for the incident |
| `DELETE /api/incidents/:incidentId/recovery` | Incident-scoped cancellation alias |

Cancellation aborts the run and preserves evidence; it does not apply or undo a
patch. There is no pause endpoint. A missing run returns `404`, and a cancelled
or uncertain execution must remain `inconclusive`.

## Reports and approval

| Method and path | Result |
| --- | --- |
| `POST /api/reports` | Validate and persist an evidence-backed `RecoveryReportRecord` |
| `GET /api/reports` | List records, optionally filtered by `incidentId` |
| `GET /api/reports/:reportId` | Read one report record |
| `GET /api/incidents/:incidentId/reports` | List reports for an incident |
| `GET /api/incidents/:incidentId/reports/:reportId` | Read an incident-scoped report |
| `GET /api/incidents/:incidentId/report` | Read the latest report compatibility route |
| `POST /api/reports/:reportId/approval` | Record one human approval or rejection decision |

The incident-scoped report and approval compatibility routes are also accepted
where present in the API implementation. A report must include validated
facts, inferences, unknowns, citations, hypotheses, patches, command results,
environment fingerprint, baseline results, and patched results. It always has
`approvalRequired: true` and starts with `approval.status: "pending"`.

Approval JSON is `{ "decision": "approved" | "rejected", "actorId":
"synthetic-reviewer", "note": "optional" }`. The `x-rift-actor-kind` header,
when supplied, must be `human`; the actor ID must be supplied and bounded. A
second decision returns `409`. Recording approval only records review intent:
it never applies a patch, changes a checkout, pushes, merges, deploys, or
authorizes production action.

## Error and evidence handling

Errors include a stable `code`; intake validation errors also include `errors`
with field paths. Preserve the `correlationId`, report ID, run ID, evidence IDs,
content hashes, repository revision, and cleanup result in an operator record.
Never put raw secrets or unredacted production data into a request, report, or
support packet. See [`operator-runbook.md`](operator-runbook.md) for escalation
and [`recovery-report-guide.md`](recovery-report-guide.md) for interpretation.
