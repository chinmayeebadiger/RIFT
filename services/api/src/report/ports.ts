import type {
  CandidatePatch,
  CommandExecution,
  CorrelationId,
  EvidenceItem,
  IncidentId,
  InvestigationResult,
  Hypothesis,
  RepositorySnapshot,
  RecoveryReport,
  VerificationPlan,
  VerificationResult,
} from "@rift/core";

export type ApprovalStatus = "pending" | "approved" | "rejected";

/** The approval record is deliberately separate from the immutable report. */
export interface ApprovalState {
  readonly status: ApprovalStatus;
  readonly requestedAt: string;
  readonly decidedAt?: string;
  readonly approverId?: string;
  readonly note?: string;
}

export interface RecoveryReportRecord {
  readonly report: RecoveryReport;
  readonly approval: ApprovalState;
}

export interface HumanApprovalRequest {
  readonly actorId: string;
  readonly actorKind?: "human";
  readonly decision: "approved" | "rejected";
  readonly note?: string;
}

export interface ReportStore {
  save(record: RecoveryReportRecord): RecoveryReportRecord;
  get(reportId: string): RecoveryReportRecord | undefined;
  list(query?: { readonly incidentId?: IncidentId }): readonly RecoveryReportRecord[];
  recordApproval(reportId: string, request: HumanApprovalRequest, now?: string): RecoveryReportRecord;
}

export interface ReportPolicy {
  /** A report never authorizes a production action. This is always true. */
  readonly approvalRequired: true;
  /** Network policy is carried from the isolated runner boundary. */
  readonly networkAccess: "disabled" | "allowlisted";
}

export interface ReportGenerationRequest {
  readonly incidentId: IncidentId;
  readonly correlationId: CorrelationId;
  readonly investigationResult: InvestigationResult;
  readonly candidatePatches: readonly CandidatePatch[];
  readonly verificationResults: readonly VerificationResult[];
  readonly verificationPlans?: readonly VerificationPlan[];
  readonly snapshot?: RepositorySnapshot;
  readonly commandExecutions?: readonly CommandExecution[];
  readonly hypotheses?: readonly Hypothesis[];
  readonly evidence: readonly EvidenceItem[];
  readonly policy: ReportPolicy;
  readonly verificationStatus?: RecoveryReport["status"];
  readonly now?: string;
}

/**
 * Assembles a report from validated worker output. It has no runner, git,
 * filesystem, deployment, or production-action capability.
 */
export interface ReportGenerator {
  generate(request: ReportGenerationRequest): RecoveryReportRecord;
}
