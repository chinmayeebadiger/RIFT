# Recovery report guide

A recovery report is a replayable record of one bounded investigation and its
isolated verification results. It is evidence for a human reviewer, not a
deployment instruction. The report is immutable after generation; approval is
stored separately and records review intent only.

## Read a report in this order

1. **Context:** `id`, `incidentId`, `correlationId`, `createdAt`, and
   `contentHash`. Confirm the repository revision and environment fingerprint
   identify the run being reviewed.
2. **Status:** interpret the terminal classification using the table below.
   A green patched check is meaningful only when the baseline first reproduced
   the expected failure.
3. **Facts, inferences, and unknowns:** facts are retained observations;
   inferences are conclusions drawn from them; unknowns are unresolved. Do not
   present an inference or unknown as an observation.
4. **Citations and hypotheses:** resolve each evidence ID and compare its
   content hash with the citation. Review hypothesis status, confidence,
   supporting/contradicting citations, and the next check.
5. **Patches and commands:** check source hypothesis, base revision, touched
   paths, rationale, expected invariant, command status, exit code, and command
   evidence. A candidate patch is not an applied production change.
6. **Verification sides:** compare `baselineResults` with `patchedResults`.
   Evidence IDs must remain partitioned; missing evidence is a report failure,
   not a reason to infer success.
7. **Approval:** start at `pending`. A human reviewer may record exactly one
   `approved` or `rejected` decision with an actor ID and optional note.

## Verification classifications

| Status | Meaning | Required operator response |
| --- | --- | --- |
| `verified` | The expected non-zero baseline reproduced and the isolated patched checks passed with complete evidence. | Review the report; this is not deployment authorization. |
| `regressed` | The patched checks failed or violated the expected invariant. | Reject the candidate and preserve evidence. |
| `not-reproduced` | The baseline was green or did not match the expected failure signature. | Do not pursue the patch from this run; verify revision, command, and signature. |
| `inconclusive` | Execution was blocked, timed out, cancelled, cleanup was uncertain, or evidence was incomplete. | Stop, preserve evidence, and escalate; never promote to `verified`. |

Reports may also carry `running`, `cancelled`, or `policy-denied` statuses at
the contract level. These are not successful repair classifications.

## Required fields and replay checks

The v1 `RecoveryReport` includes:

- `hypothesisSetId`, `hypotheses`, `facts`, `inferences`, `unknowns`, and
  `evidenceCitations`;
- `candidatePatchIds` and `patches` with touched paths and expected invariants;
- `commands` and their evidence IDs;
- `environmentFingerprint` with snapshot and repository revision;
- separate `baselineResults` and `patchedResults`;
- `verificationResultIds`, `evidenceIds`, `approvalRequired: true`, and a
  content hash.

Before approving, the reviewer should be able to resolve every cited evidence
ID, verify citation and report hashes, confirm the exact revision and policy,
inspect baseline and patched outputs, and explain every unknown. If any record
is missing, inconsistent, secret-bearing, or cleanup is uncertain, leave the
report unapproved and follow the escalation path in the operator runbook.

## Approval boundary

The local API accepts approval only from a bounded actor marked as human, but
the actor header/body is not authentication. An outer identity and transport
boundary is required for sensitive use. Even an approved report does not apply
the candidate patch, modify the caller's checkout, push or merge a branch,
deploy, or call production. Those actions are outside this MVP.
