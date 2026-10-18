import { describe, expect, it } from "vitest";
import { withEvidenceHash } from "../domain/hashing.js";
import { EvidenceBackedReportGenerator, ReportGenerationError } from "./generator.js";
import { InMemoryReportStore, ReportStoreError } from "./store.js";

const TIME = "2026-10-18T10:00:00.000Z";
const HASH = `sha256:${"a".repeat(64)}`;

function evidence() {
  return withEvidenceHash({
    kind: "EvidenceItem",
    schemaVersion: 1,
    id: "evidence-1",
    incidentId: "RIFT-042",
    correlationId: "run-1",
    createdAt: TIME,
    content: { message: "baseline failed" },
    source: { type: "runner", locator: "runner/baseline/stderr" },
    capturedAt: TIME,
    redaction: { status: "not-required" },
    provenance: { actor: "runner", tool: "fake-runner" },
  });
}

function request() {
  return {
    incidentId: "RIFT-042",
    correlationId: "run-1",
    investigationResult: {
      kind: "InvestigationResult" as const,
      schemaVersion: 1 as const,
      id: "investigation-1",
      incidentId: "RIFT-042",
      correlationId: "run-1",
      createdAt: TIME,
      contentHash: HASH,
      snapshotId: "snapshot-1",
      commandExecutionIds: [],
      logNormalizationIds: [],
      timelineId: "timeline-1",
      hypothesisSetId: "hypotheses-1",
      hypothesisEvidence: [],
      evidenceIds: ["evidence-1"],
      status: "completed" as const,
      facts: ["The baseline reproduced the incident."],
      inferences: ["The candidate addresses the observed failure."],
      unknowns: ["Production traffic was not tested."],
    },
    candidatePatches: [{
      kind: "CandidatePatch" as const,
      schemaVersion: 1 as const,
      id: "patch-1",
      incidentId: "RIFT-042",
      correlationId: "run-1",
      createdAt: TIME,
      contentHash: HASH,
      sourceHypothesisId: "hypothesis-1",
      baseRevision: { repository: "rift", revision: "abcdef1" },
      diff: "diff --git a/src/checkout.ts b/src/checkout.ts\n--- a/src/checkout.ts\n+++ b/src/checkout.ts\n@@ -1 +1 @@\n-old\n+new\n",
      touchedPaths: ["src/checkout.ts"],
      rationale: "Apply the discount once.",
      expectedInvariant: "The checkout total is discounted once.",
      generatedBy: { actor: "fake-model" as const },
    }],
    verificationResults: [{
      kind: "VerificationResult" as const,
      schemaVersion: 1 as const,
      id: "result-1",
      incidentId: "RIFT-042",
      correlationId: "run-1",
      createdAt: TIME,
      contentHash: HASH,
      verificationPlanId: "plan-1",
      classification: "verified" as const,
      baselineExitCode: 1,
      patchedExitCode: 0,
      evidenceIds: ["evidence-1"],
    }],
    verificationPlans: [{
      kind: "VerificationPlan" as const,
      schemaVersion: 1 as const,
      id: "plan-1",
      incidentId: "RIFT-042",
      correlationId: "run-1",
      createdAt: TIME,
      contentHash: HASH,
      candidatePatchId: "patch-1",
      baseRevision: { repository: "rift", revision: "abcdef1" },
      baselineCommand: { command: "npm", args: ["test"] },
      verificationCommands: [{ command: "npm", args: ["test"] }],
      timeoutMs: 30_000,
      networkAccess: "disabled" as const,
    }],
    evidence: [evidence()],
    policy: { approvalRequired: true as const, networkAccess: "disabled" as const },
    now: TIME,
  };
}

describe("evidence-backed recovery reports", () => {
  it("builds a replayable report and leaves approval pending", () => {
    const record = new EvidenceBackedReportGenerator().generate(request());
    expect(record.report.status).toBe("verified");
    expect(record.report.evidenceIds).toEqual(["evidence-1"]);
    expect(record.report.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(record.approval).toEqual({ status: "pending", requestedAt: TIME });
  });

  it("keeps facts, citations, hypotheses, patches, commands, fingerprints, and result sides distinct", () => {
    const item = evidence();
    const input = request();
    const record = new EvidenceBackedReportGenerator().generate({
      ...input,
      evidence: [item],
      investigationResult: {
        ...input.investigationResult,
        hypothesisEvidence: [{ hypothesisId: "hypothesis-1", citations: [{ evidenceId: item.id, evidenceHash: item.contentHash, relation: "supports", locator: "runner/baseline/stderr" }] }],
      },
      hypotheses: [{
        kind: "Hypothesis",
        schemaVersion: 1,
        id: "hypothesis-1",
        incidentId: "RIFT-042",
        correlationId: "run-1",
        createdAt: TIME,
        contentHash: HASH,
        statement: "The checkout retry path exhausts the pool.",
        status: "confirmed",
        confidence: 0.9,
        supportingEvidenceIds: [item.id],
        contradictingEvidenceIds: [],
        assumptions: [],
        nextCheck: "Run the bounded retry suite.",
      }],
      snapshot: {
        kind: "RepositorySnapshot",
        schemaVersion: 1,
        id: "snapshot-1",
        incidentId: "RIFT-042",
        correlationId: "run-1",
        createdAt: TIME,
        contentHash: HASH,
        repositoryRevision: { repository: "rift", revision: "abcdef1" },
        files: [],
        adapter: { name: "fixture", version: "1" },
      },
      commandExecutions: [{
        kind: "CommandExecution",
        schemaVersion: 1,
        id: "execution-1",
        incidentId: "RIFT-042",
        correlationId: "run-1",
        createdAt: TIME,
        contentHash: HASH,
        snapshotId: "snapshot-1",
        command: { command: "npm", args: ["test"] },
        status: "failed",
        exitCode: 1,
        startedAt: TIME,
        finishedAt: TIME,
        evidenceIds: [item.id],
      }],
    });
    expect(record.report.evidenceCitations).toHaveLength(1);
    expect(record.report.hypotheses[0]?.statement).toContain("exhausts");
    expect(record.report.patches[0]?.candidatePatchId).toBe("patch-1");
    expect(record.report.commands[0]?.status).toBe("failed");
    expect(record.report.environmentFingerprint?.snapshotId).toBe("snapshot-1");
    expect(record.report.baselineResults[0]?.exitCode).toBe(1);
    expect(record.report.patchedResults[0]?.exitCode).toBe(0);
  });

  it("rejects missing evidence and network policy escalation", () => {
    expect(() => new EvidenceBackedReportGenerator().generate({
      ...request(),
      evidence: [],
    })).toThrowError(new ReportGenerationError("Verification result references missing evidence: evidence-1", "REPORT_EVIDENCE_MISSING"));

    expect(() => new EvidenceBackedReportGenerator().generate({
      ...request(),
      policy: { approvalRequired: true, networkAccess: "disabled" },
      verificationPlans: request().verificationPlans?.map((plan) => ({ ...plan, networkAccess: "allowlisted" as const })),
    })).toThrowError("Verification plan network access exceeds report policy");
  });

  it("records only one explicit human approval decision", () => {
    const store = new InMemoryReportStore([new EvidenceBackedReportGenerator().generate(request())]);
    const approved = store.recordApproval("report-RIFT-042-run-1", { actorId: "alice", decision: "approved", note: "Reviewed diff and evidence." }, TIME);
    expect(approved.approval).toMatchObject({ status: "approved", approverId: "alice", decidedAt: TIME });
    expect(() => store.recordApproval("report-RIFT-042-run-1", { actorId: "bob", decision: "approved" }, TIME)).toThrowError(ReportStoreError);
    expect(store.get("report-RIFT-042-run-1")?.report.status).toBe("verified");
  });

  it("rejects evidence from another incident or correlation", () => {
    expect(() => new EvidenceBackedReportGenerator().generate({
      ...request(),
      evidence: [{ ...evidence(), incidentId: "RIFT-999" }],
    })).toThrowError("Evidence context does not match report request: evidence-1");
  });
});
