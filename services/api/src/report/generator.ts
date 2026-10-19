import {
  validateCandidatePatch,
  validateCommandExecution,
  validateEvidenceItem,
  validateInvestigationResult,
  validateHypothesis,
  validateRepositorySnapshot,
  validateRecoveryReport,
  validateVerificationPlan,
  validateVerificationResult,
} from "@rift/core";
import type {
  CandidatePatch,
  EvidenceCitation,
  EvidenceItem,
  RecoveryReport,
  VerificationResult,
} from "@rift/core";
import { sha256 } from "../domain/hashing.js";
import type { ApprovalState, RecoveryReportRecord, ReportGenerationRequest, ReportGenerator } from "./ports.js";

export class ReportGenerationError extends Error {
  public constructor(
    message: string,
    public readonly code:
      | "REPORT_INPUT_INVALID"
      | "REPORT_EVIDENCE_MISSING"
      | "REPORT_POLICY_DENIED"
      | "REPORT_INCONSISTENT_RUN",
  ) {
    super(message);
    this.name = "ReportGenerationError";
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function issueText(result: { readonly ok: false; readonly issues: readonly { path: string; code: string }[] }): string {
  return result.issues.map((entry) => `${entry.path}:${entry.code}`).join(", ");
}

function assertValid(value: unknown, result: ReturnType<typeof validateEvidenceItem>, label: string): void {
  if (!result.ok) throw new ReportGenerationError(`${label} failed contract validation: ${issueText(result)}`, "REPORT_INPUT_INVALID");
}

function reportStatus(results: readonly VerificationResult[], requested?: RecoveryReport["status"]): RecoveryReport["status"] {
  if (results.length === 0) return requested === "verified" ? "inconclusive" : requested ?? "inconclusive";
  const classifications = new Set(results.map((result) => result.classification));
  if (classifications.has("regressed")) return "regressed";
  if (classifications.has("not-reproduced")) return "not-reproduced";
  if (classifications.has("inconclusive")) return "inconclusive";
  return "verified";
}

function reportHash(report: Omit<RecoveryReport, "contentHash">): RecoveryReport["contentHash"] {
  return sha256(report as never);
}

/**
 * Deterministically assembles an evidence-backed report. Worker/runner output
 * is treated as untrusted and no command or patch operation is performed here.
 */
export class EvidenceBackedReportGenerator implements ReportGenerator {
  public generate(request: ReportGenerationRequest): RecoveryReportRecord {
    if (!isRecord(request) || typeof request.incidentId !== "string" || typeof request.correlationId !== "string" || !Array.isArray(request.evidence) || !Array.isArray(request.candidatePatches) || !Array.isArray(request.verificationResults) || !isRecord(request.investigationResult)) {
      throw new ReportGenerationError("Recovery report request is missing required fields", "REPORT_INPUT_INVALID");
    }
    const policy = isRecord(request) ? request.policy : undefined;
    if (!isRecord(policy) || policy.approvalRequired !== true) {
      throw new ReportGenerationError("Recovery reports always require human approval", "REPORT_POLICY_DENIED");
    }
    if (policy.networkAccess !== "disabled" && policy.networkAccess !== "allowlisted") {
      throw new ReportGenerationError("Runner network policy is invalid", "REPORT_POLICY_DENIED");
    }

    const investigationValidation = validateInvestigationResult(request.investigationResult);
    if (!investigationValidation.ok) throw new ReportGenerationError(`Investigation result failed contract validation: ${issueText(investigationValidation)}`, "REPORT_INPUT_INVALID");
    if (request.investigationResult.incidentId !== request.incidentId || request.investigationResult.correlationId !== request.correlationId) {
      throw new ReportGenerationError("Investigation result context does not match report request", "REPORT_INCONSISTENT_RUN");
    }
    const evidenceById = new Map<string, EvidenceItem>();
    for (const evidence of request.evidence) {
      const validation = validateEvidenceItem(evidence);
      assertValid(evidence, validation, `Evidence ${evidence.id}`);
      if (evidence.incidentId !== request.incidentId || evidence.correlationId !== request.correlationId) {
        throw new ReportGenerationError(`Evidence context does not match report request: ${evidence.id}`, "REPORT_INCONSISTENT_RUN");
      }
      if (evidenceById.has(evidence.id)) throw new ReportGenerationError(`Duplicate evidence id: ${evidence.id}`, "REPORT_INPUT_INVALID");
      evidenceById.set(evidence.id, evidence);
    }

    for (const patch of request.candidatePatches) {
      const validation = validateCandidatePatch(patch);
      if (!validation.ok) throw new ReportGenerationError(`Candidate patch failed contract validation: ${issueText(validation)}`, "REPORT_INPUT_INVALID");
      if (patch.incidentId !== request.incidentId || patch.correlationId !== request.correlationId) {
        throw new ReportGenerationError(`Candidate patch context does not match report request: ${patch.id}`, "REPORT_INCONSISTENT_RUN");
      }
    }
    if (request.snapshot !== undefined) {
      const validation = validateRepositorySnapshot(request.snapshot);
      if (!validation.ok) throw new ReportGenerationError(`Repository snapshot failed contract validation: ${issueText(validation)}`, "REPORT_INPUT_INVALID");
      if (request.snapshot.incidentId !== request.incidentId || request.snapshot.correlationId !== request.correlationId) throw new ReportGenerationError("Repository snapshot context does not match report request", "REPORT_INCONSISTENT_RUN");
    }
    for (const execution of request.commandExecutions ?? []) {
      const validation = validateCommandExecution(execution);
      if (!validation.ok) throw new ReportGenerationError(`Command execution failed contract validation: ${issueText(validation)}`, "REPORT_INPUT_INVALID");
      if (execution.incidentId !== request.incidentId || execution.correlationId !== request.correlationId) throw new ReportGenerationError(`Command execution context does not match report request: ${execution.id}`, "REPORT_INCONSISTENT_RUN");
      for (const evidenceId of execution.evidenceIds) if (!evidenceById.has(evidenceId)) throw new ReportGenerationError(`Command execution references missing evidence: ${evidenceId}`, "REPORT_EVIDENCE_MISSING");
    }
    for (const hypothesis of request.hypotheses ?? []) {
      const validation = validateHypothesis(hypothesis);
      if (!validation.ok) throw new ReportGenerationError(`Hypothesis failed contract validation: ${issueText(validation)}`, "REPORT_INPUT_INVALID");
      if (hypothesis.incidentId !== request.incidentId || hypothesis.correlationId !== request.correlationId) throw new ReportGenerationError(`Hypothesis context does not match report request: ${hypothesis.id}`, "REPORT_INCONSISTENT_RUN");
    }
    for (const result of request.verificationResults) {
      const validation = validateVerificationResult(result);
      if (!validation.ok) throw new ReportGenerationError(`Verification result failed contract validation: ${issueText(validation)}`, "REPORT_INPUT_INVALID");
      if (result.incidentId !== request.incidentId || result.correlationId !== request.correlationId) {
        throw new ReportGenerationError(`Verification result context does not match report request: ${result.id}`, "REPORT_INCONSISTENT_RUN");
      }
      for (const evidenceId of result.evidenceIds) {
        if (!evidenceById.has(evidenceId)) throw new ReportGenerationError(`Verification result references missing evidence: ${evidenceId}`, "REPORT_EVIDENCE_MISSING");
      }
    }
    if (request.verificationPlans !== undefined) {
      const plans = new Map<string, (typeof request.verificationPlans)[number]>();
      for (const plan of request.verificationPlans) {
        const validation = validateVerificationPlan(plan);
        if (!validation.ok) throw new ReportGenerationError(`Verification plan failed contract validation: ${issueText(validation)}`, "REPORT_INPUT_INVALID");
        plans.set(plan.id, plan);
      }
      for (const result of request.verificationResults) {
        const plan = plans.get(result.verificationPlanId);
        if (plan === undefined) throw new ReportGenerationError(`Verification result has no matching plan: ${result.verificationPlanId}`, "REPORT_INCONSISTENT_RUN");
        if (plan.networkAccess === "allowlisted" && policy.networkAccess !== "allowlisted") {
          throw new ReportGenerationError("Verification plan network access exceeds report policy", "REPORT_POLICY_DENIED");
        }
      }
    }

    const citedEvidenceIds = unique([
      ...request.investigationResult.evidenceIds,
      ...request.verificationResults.flatMap((result) => result.evidenceIds),
      ...(request.commandExecutions ?? []).flatMap((execution) => execution.evidenceIds),
      ...request.investigationResult.hypothesisEvidence.flatMap((entry) => entry.citations.map((citation) => citation.evidenceId)),
    ]);
    for (const evidenceId of citedEvidenceIds) {
      if (!evidenceById.has(evidenceId)) throw new ReportGenerationError(`Investigation references missing evidence: ${evidenceId}`, "REPORT_EVIDENCE_MISSING");
    }
    const citations: EvidenceCitation[] = request.investigationResult.hypothesisEvidence.flatMap((entry) => entry.citations.map((citation) => {
      const evidence = evidenceById.get(citation.evidenceId);
      if (evidence === undefined || evidence.contentHash !== citation.evidenceHash) throw new ReportGenerationError(`Evidence citation hash does not match evidence: ${citation.evidenceId}`, "REPORT_INCONSISTENT_RUN");
      return { ...citation };
    }));
    const now = request.now ?? new Date().toISOString();
    const withoutHash: Omit<RecoveryReport, "contentHash"> = {
      kind: "RecoveryReport",
      schemaVersion: 1,
      id: `report-${request.incidentId}-${request.correlationId}`,
      incidentId: request.incidentId,
      correlationId: request.correlationId,
      createdAt: now,
       status: reportStatus(request.verificationResults, request.verificationStatus),
      hypothesisSetId: request.investigationResult.hypothesisSetId,
      candidatePatchIds: unique(request.candidatePatches.map((patch) => patch.id)),
      verificationResultIds: unique(request.verificationResults.map((result) => result.id)),
      facts: unique(request.investigationResult.facts),
      inferences: unique(request.investigationResult.inferences),
       unknowns: unique(request.investigationResult.unknowns),
       evidenceCitations: citations,
       hypotheses: (request.hypotheses ?? []).map((hypothesis) => ({
         hypothesisId: hypothesis.id,
         statement: hypothesis.statement,
         status: hypothesis.status,
         confidence: hypothesis.confidence,
         citations: request.investigationResult.hypothesisEvidence.find((entry) => entry.hypothesisId === hypothesis.id)?.citations ?? [],
       })),
       patches: request.candidatePatches.map((patch) => ({
         candidatePatchId: patch.id,
         sourceHypothesisId: patch.sourceHypothesisId,
         touchedPaths: [...patch.touchedPaths],
         rationale: patch.rationale,
         expectedInvariant: patch.expectedInvariant,
       })),
       commands: (request.commandExecutions ?? []).map((execution) => ({
         executionId: execution.id,
         command: execution.command,
         status: execution.status,
         exitCode: execution.exitCode,
         evidenceIds: [...execution.evidenceIds],
       })),
       environmentFingerprint: request.snapshot === undefined ? null : {
         snapshotId: request.snapshot.id,
         repositoryRevision: request.snapshot.repositoryRevision,
         adapter: request.snapshot.adapter,
       },
        baselineResults: request.verificationResults.map((result) => ({ verificationResultId: result.id, exitCode: result.baselineExitCode, evidenceIds: [...(result.baselineEvidenceIds ?? [])] })),
        patchedResults: request.verificationResults.map((result) => ({ verificationResultId: result.id, exitCode: result.patchedExitCode, evidenceIds: [...(result.patchedEvidenceIds ?? [])] })),
      approvalRequired: true,
      evidenceIds: citedEvidenceIds,
    };
    const report = { ...withoutHash, contentHash: reportHash(withoutHash) } as RecoveryReport;
    const validation = validateRecoveryReport(report);
    if (!validation.ok) throw new ReportGenerationError(`Generated report failed contract validation: ${issueText(validation)}`, "REPORT_INPUT_INVALID");
    const approval: ApprovalState = { status: "pending", requestedAt: now };
    return { report: clone(report), approval };
  }
}

export const RecoveryReportGenerator = EvidenceBackedReportGenerator;
