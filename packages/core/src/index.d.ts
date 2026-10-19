export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export const CONTRACT_SCHEMA_VERSION: 1;
export const M1_SCHEMA_VERSION: 1;
export type ContractSchemaVersion = typeof CONTRACT_SCHEMA_VERSION;
export type SchemaVersion = ContractSchemaVersion;

export type IncidentId = string;
export type ManifestId = string;
export type EvidenceId = string;
export type HypothesisId = string;
export type HypothesisSetId = string;
export type CandidatePatchId = string;
export type VerificationPlanId = string;
export type VerificationResultId = string;
export type RecoveryReportId = string;
export type AuditEventId = string;
export type CorrelationId = string;
export type Timestamp = string;
export type Sha256Hash = string;

export type RepositorySnapshotId = string;
export type CommandExecutionId = string;
export type LogNormalizationId = string;
export type InvestigationTimelineId = string;
export type InvestigationResultId = string;

export interface VersionedContract {
  readonly schemaVersion: ContractSchemaVersion;
  readonly id: string;
  readonly incidentId: string;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly contentHash: string;
}

export interface RepositoryRevision {
  readonly repository: string;
  readonly revision: string;
}

export interface ManifestLogSource {
  readonly id: string;
  readonly type: string;
  readonly locator: string;
  readonly contentHash?: string;
}

export interface CommandSpec {
  readonly command: string;
  readonly args?: readonly string[];
  readonly workingDirectory?: string;
  readonly environment?: Readonly<Record<string, string>>;
}

export interface TimeWindow {
  readonly start: string;
  readonly end: string;
}

export interface IncidentPolicy {
  readonly networkAccess?: "disabled" | "allowlisted";
  readonly allowedCommands?: readonly string[];
  readonly maxEvidenceBytes?: number;
  readonly redactSecrets?: boolean;
  readonly [key: string]: JsonValue | undefined;
}

export interface IncidentManifest extends VersionedContract {
  readonly kind: "IncidentManifest";
  readonly repositoryRevision: RepositoryRevision;
  readonly allowedPaths: readonly string[];
  readonly logSources: readonly ManifestLogSource[];
  readonly reproductionCommand: CommandSpec;
  readonly testCommands: readonly CommandSpec[];
  readonly timeWindow: TimeWindow;
  readonly policy: IncidentPolicy;
}

export type EvidenceRedactionStatus = "not-required" | "redacted" | "pending";
export interface EvidenceSource { readonly type: string; readonly locator: string; }
export interface EvidenceRedaction { readonly status: EvidenceRedactionStatus; readonly rules?: readonly string[]; }
export interface Provenance {
  readonly actor: string;
  readonly tool?: string;
  readonly sourceHash?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}
export type EvidenceProvenance = Provenance;
export interface EvidenceItem extends VersionedContract {
  readonly kind: "EvidenceItem";
  readonly content: JsonValue;
  readonly source: EvidenceSource;
  readonly capturedAt: string;
  readonly redaction: EvidenceRedaction;
  readonly provenance: Provenance;
}

export type HypothesisStatus = "open" | "confirmed" | "rejected" | "inconclusive";
export interface Hypothesis extends VersionedContract {
  readonly kind: "Hypothesis";
  readonly statement: string;
  readonly status: HypothesisStatus;
  readonly confidence: number;
  readonly supportingEvidenceIds: readonly EvidenceId[];
  readonly contradictingEvidenceIds: readonly EvidenceId[];
  readonly assumptions: readonly string[];
  readonly nextCheck: string;
}
export interface HypothesisSet extends VersionedContract {
  readonly kind: "HypothesisSet";
  readonly hypotheses: readonly Hypothesis[];
  readonly rankingMethod: string;
}

export interface CandidatePatch extends VersionedContract {
  readonly kind: "CandidatePatch";
  readonly sourceHypothesisId: HypothesisId;
  readonly baseRevision: RepositoryRevision;
  readonly diff: string;
  readonly touchedPaths: readonly string[];
  readonly rationale: string;
  readonly expectedInvariant: string;
  /** Optional structured detail; the required statement remains the v1 field. */
  readonly expectedInvariantDetails?: ExpectedInvariant;
  readonly generatedBy: { readonly actor: "fake-model" | "gpt-6-astra" | "human"; readonly model?: string };
}

/** A reviewable invariant statement carried alongside a candidate patch. */
export interface ExpectedInvariant {
  readonly statement: string;
  readonly verificationHint?: string;
}

export type DiffValidationIssueCode =
  | "malformed_diff"
  | "empty_diff"
  | "path_not_allowed"
  | "path_mismatch"
  | "unsupported_change"
  | "base_revision_mismatch"
  | "diff_too_large";

export interface DiffValidationIssue extends ValidationIssue {
  readonly code: DiffValidationIssueCode;
  readonly message?: string;
}

export interface DiffValidationResult {
  readonly valid: boolean;
  readonly touchedPaths: readonly string[];
  readonly issues: readonly DiffValidationIssue[];
}

export interface PatchModelProposal {
  readonly candidatePatches: readonly CandidatePatch[];
}

export interface PatchRankingEntry {
  readonly candidatePatchId: CandidatePatchId;
  readonly rank: number;
  readonly score: number;
  readonly rationale: string;
}

export interface PatchRanking {
  readonly method: string;
  readonly entries: readonly PatchRankingEntry[];
}

export type PatchGenerationStatus = "generated" | "rejected" | "inconclusive";
export interface PatchGenerationResponse extends VersionedContract {
  readonly kind: "PatchGenerationResponse";
  readonly hypothesisSetId: HypothesisSetId;
  readonly candidatePatches: readonly CandidatePatch[];
  readonly ranking: PatchRanking | null;
  readonly status: PatchGenerationStatus;
  readonly validationIssues: readonly DiffValidationIssue[];
}

export interface PatchApiErrorIssue {
  readonly path?: string;
  readonly code: string;
  readonly message?: string;
}

export interface PatchApiErrorResponse {
  readonly error: string;
  readonly code: string;
  readonly errors: readonly PatchApiErrorIssue[];
}

export type PatchApiResponse = PatchGenerationResponse | PatchApiErrorResponse;

export interface VerificationPlan extends VersionedContract {
  readonly kind: "VerificationPlan";
  readonly candidatePatchId: CandidatePatchId;
  readonly baseRevision: RepositoryRevision;
  readonly baselineCommand: CommandSpec;
  readonly verificationCommands: readonly CommandSpec[];
  readonly timeoutMs: number;
  readonly networkAccess: "disabled" | "allowlisted";
}

export type VerificationClassification = "verified" | "regressed" | "not-reproduced" | "inconclusive";
export interface VerificationResult extends VersionedContract {
  readonly kind: "VerificationResult";
  readonly verificationPlanId: VerificationPlanId;
  readonly classification: VerificationClassification;
  readonly baselineExitCode: number | null;
  readonly patchedExitCode: number | null;
  readonly evidenceIds: readonly EvidenceId[];
  /** Additive provenance partition; never conflate the two execution sides. */
  readonly baselineEvidenceIds?: readonly EvidenceId[];
  readonly patchedEvidenceIds?: readonly EvidenceId[];
  readonly failure?: { readonly code: string; readonly message: string };
}

export type RecoveryReportStatus = VerificationClassification | "running" | "cancelled" | "policy-denied";
export interface RecoveryReportHypothesis {
  readonly hypothesisId: HypothesisId;
  readonly statement: string;
  readonly status: HypothesisStatus;
  readonly confidence: number;
  readonly citations: readonly EvidenceCitation[];
}
export interface RecoveryReportPatch {
  readonly candidatePatchId: CandidatePatchId;
  readonly sourceHypothesisId: HypothesisId;
  readonly touchedPaths: readonly string[];
  readonly rationale: string;
  readonly expectedInvariant: string;
}
export interface RecoveryReportCommand {
  readonly executionId: CommandExecutionId;
  readonly command: CommandSpec;
  readonly status: CommandExecutionStatus;
  readonly exitCode: number | null;
  readonly evidenceIds: readonly EvidenceId[];
}
export interface RecoveryReportEnvironmentFingerprint {
  readonly snapshotId: RepositorySnapshotId;
  readonly repositoryRevision: RepositoryRevision;
  readonly adapter?: { readonly name: string; readonly version: string };
}
export interface RecoveryReportResult {
  readonly verificationResultId: VerificationResultId;
  readonly exitCode: number | null;
  readonly evidenceIds: readonly EvidenceId[];
}
export interface RecoveryReport extends VersionedContract {
  readonly kind: "RecoveryReport";
  readonly status: RecoveryReportStatus;
  readonly hypothesisSetId: HypothesisSetId;
  readonly candidatePatchIds: readonly CandidatePatchId[];
  readonly verificationResultIds: readonly VerificationResultId[];
  readonly facts: readonly string[];
  readonly inferences: readonly string[];
  readonly unknowns: readonly string[];
  readonly evidenceCitations: readonly EvidenceCitation[];
  readonly hypotheses: readonly RecoveryReportHypothesis[];
  readonly patches: readonly RecoveryReportPatch[];
  readonly commands: readonly RecoveryReportCommand[];
  readonly environmentFingerprint: RecoveryReportEnvironmentFingerprint | null;
  readonly baselineResults: readonly RecoveryReportResult[];
  readonly patchedResults: readonly RecoveryReportResult[];
  readonly approvalRequired: true;
  readonly evidenceIds: readonly EvidenceId[];
}

export type AuditActorKind = "system" | "human" | "worker" | "model";
export type AuditAction =
  | "intake.validate"
  | "evidence.import"
  | "policy.evaluate"
  | "model.call"
  | "sandbox.create"
  | "external.action"
  | "verification.stage"
  | "verification.execute"
  | "verification.patch"
  | "verification.check"
  | "verification.cleanup"
  | "verification.cancel"
  | "verification.retry";
export type VerificationAuditStage = "validate" | "baseline" | "patch" | "checks" | "classify" | "cleanup";
export type AuditResult = "succeeded" | "failed" | "denied";
export interface AuditEvent extends VersionedContract {
  readonly kind: "AuditEvent";
  readonly occurredAt: string;
  readonly actor: { readonly kind: AuditActorKind; readonly id: string };
  readonly action: AuditAction;
  readonly policyDecision: { readonly outcome: "allowed" | "denied"; readonly policyId: string; readonly reasonCode: string };
  readonly result: AuditResult;
  readonly inputHashes: readonly string[];
  readonly outputHashes: readonly string[];
  readonly stage?: VerificationAuditStage;
  readonly attempt?: number;
  readonly failure?: { readonly code: string };
}

/** M2 baseline reproduction and investigation contracts. */
export interface RepositorySnapshotFile {
  readonly path: string;
  readonly contentHash: Sha256Hash;
  readonly byteLength: number;
}

export interface RepositorySnapshot extends VersionedContract {
  readonly kind: "RepositorySnapshot";
  readonly repositoryRevision: RepositoryRevision;
  readonly files: readonly RepositorySnapshotFile[];
  readonly adapter: { readonly name: string; readonly version: string };
}

export type CommandExecutionStatus = "succeeded" | "failed" | "timed-out" | "cancelled" | "blocked";
export interface CommandExecution extends VersionedContract {
  readonly kind: "CommandExecution";
  readonly snapshotId: RepositorySnapshotId;
  readonly command: CommandSpec;
  readonly status: CommandExecutionStatus;
  readonly exitCode: number | null;
  readonly startedAt: Timestamp;
  readonly finishedAt: Timestamp;
  readonly stdoutEvidenceId?: EvidenceId;
  readonly stderrEvidenceId?: EvidenceId;
  readonly evidenceIds: readonly EvidenceId[];
  readonly failure?: { readonly code: string; readonly message: string };
}

export type NormalizedLogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "unknown";
export interface NormalizedStackFrame {
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly function?: string;
}
export interface NormalizedStackTrace {
  readonly exceptionType?: string;
  readonly message?: string;
  readonly frames: readonly NormalizedStackFrame[];
}
export interface NormalizedLogRecord {
  readonly occurredAt?: Timestamp;
  readonly level: NormalizedLogLevel;
  readonly message: string;
  readonly sourceEvidenceId: EvidenceId;
  readonly sourceLineStart?: number;
  readonly sourceLineEnd?: number;
  readonly attributes?: Readonly<Record<string, JsonValue>>;
  readonly stackTrace?: NormalizedStackTrace;
}
export interface LogNormalization extends VersionedContract {
  readonly kind: "LogNormalization";
  readonly inputEvidenceIds: readonly EvidenceId[];
  readonly records: readonly NormalizedLogRecord[];
  readonly normalizer: { readonly name: string; readonly version: string };
}

export type EvidenceCitationRelation = "supports" | "contradicts" | "context";
export interface EvidenceCitation {
  readonly evidenceId: EvidenceId;
  readonly evidenceHash: Sha256Hash;
  readonly relation: EvidenceCitationRelation;
  readonly locator: string;
  readonly excerptHash?: Sha256Hash;
}
export interface HypothesisEvidence {
  readonly hypothesisId: HypothesisId;
  readonly citations: readonly EvidenceCitation[];
}

export type TimelineEventKind = "observation" | "failure" | "command" | "commit" | "hypothesis" | "unknown";
export type TimelineCertainty = "observed" | "inferred" | "unknown";
export interface InvestigationTimelineEvent {
  readonly sequence: number;
  readonly occurredAt?: Timestamp;
  readonly kind: TimelineEventKind;
  readonly certainty: TimelineCertainty;
  readonly summary: string;
  readonly citations: readonly EvidenceCitation[];
}
export interface InvestigationTimeline extends VersionedContract {
  readonly kind: "InvestigationTimeline";
  readonly events: readonly InvestigationTimelineEvent[];
  readonly timeWindow?: TimeWindow;
}

export type InvestigationStatus = "completed" | "inconclusive" | "failed";
export interface InvestigationResult extends VersionedContract {
  readonly kind: "InvestigationResult";
  readonly snapshotId: RepositorySnapshotId;
  readonly commandExecutionIds: readonly CommandExecutionId[];
  readonly logNormalizationIds: readonly LogNormalizationId[];
  readonly timelineId: InvestigationTimelineId;
  readonly hypothesisSetId: HypothesisSetId;
  readonly hypothesisEvidence: readonly HypothesisEvidence[];
  readonly evidenceIds: readonly EvidenceId[];
  readonly status: InvestigationStatus;
  readonly facts: readonly string[];
  readonly inferences: readonly string[];
  readonly unknowns: readonly string[];
  readonly failure?: { readonly code: string; readonly message: string };
}

export interface ValidationIssue { readonly path: string; readonly code: string; }
export type ValidationResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

export const MAX_ID_LENGTH: 128;
export const MAX_STRING_LENGTH: 512;
export const MAX_JSON_DEPTH: 16;
export const MAX_JSON_KEYS: 128;
export const MAX_ARRAY_LENGTH: 128;
export const MAX_COMMAND_ARGUMENTS: 64;
export const MAX_COMMAND_TIMEOUT_MS: 1800000;
export const MAX_EVIDENCE_BYTES: 104857600;
export const MAX_CONTENT_BYTES: 1048576;
export const MAX_DIFF_BYTES: 1048576;
export const MAX_PATCH_BYTES: 1048576;
export const MAX_PATCH_DIFF_BYTES: 1048576;
export const DEFAULT_PROTECTED_PATHS: readonly string[];

export interface CandidatePatchValidationContext {
  readonly allowedPaths?: readonly string[];
  readonly protectedPaths?: readonly string[];
  readonly additionalProtectedPaths?: readonly string[];
  readonly maxPatchBytes?: number;
}

export interface CandidatePatchValidationOptions extends CandidatePatchValidationContext {
  readonly context?: CandidatePatchValidationContext;
}

export function validateIncidentId(value: unknown): ValidationResult<IncidentId>;
export function validateManifestId(value: unknown): ValidationResult<ManifestId>;
export function validateEvidenceId(value: unknown): ValidationResult<EvidenceId>;
export function validateHypothesisId(value: unknown): ValidationResult<HypothesisId>;
export function validateHypothesisSetId(value: unknown): ValidationResult<HypothesisSetId>;
export function validateCandidatePatchId(value: unknown): ValidationResult<CandidatePatchId>;
export function validateVerificationPlanId(value: unknown): ValidationResult<VerificationPlanId>;
export function validateVerificationResultId(value: unknown): ValidationResult<VerificationResultId>;
export function validateRecoveryReportId(value: unknown): ValidationResult<RecoveryReportId>;
export function validateAuditEventId(value: unknown): ValidationResult<AuditEventId>;
export function validateCorrelationId(value: unknown): ValidationResult<CorrelationId>;
export function validateTimestamp(value: unknown): ValidationResult<Timestamp>;
export function validateSha256Hash(value: unknown): ValidationResult<Sha256Hash>;
export function validateProvenance(value: unknown): ValidationResult<Provenance>;
export function validateIncidentManifest(value: unknown): ValidationResult<IncidentManifest>;
export function validateEvidenceItem(value: unknown): ValidationResult<EvidenceItem>;
export function validateHypothesis(value: unknown): ValidationResult<Hypothesis>;
export function validateHypothesisSet(value: unknown): ValidationResult<HypothesisSet>;
export function validateCandidatePatch(value: unknown, options?: CandidatePatchValidationOptions): ValidationResult<CandidatePatch>;
export function validateVerificationPlan(value: unknown): ValidationResult<VerificationPlan>;
export function validateVerificationResult(value: unknown): ValidationResult<VerificationResult>;
export function validateRepositorySnapshot(value: unknown): ValidationResult<RepositorySnapshot>;
export function validateCommandExecution(value: unknown): ValidationResult<CommandExecution>;
export function validateRecoveryReport(value: unknown): ValidationResult<RecoveryReport>;
export function validateInvestigationResult(value: unknown): ValidationResult<InvestigationResult>;
export function validateAuditEvent(value: unknown): ValidationResult<AuditEvent>;
export function isIncidentId(value: unknown): value is IncidentId;
export function isManifestId(value: unknown): value is ManifestId;
export function isEvidenceId(value: unknown): value is EvidenceId;
export function isAuditEventId(value: unknown): value is AuditEventId;
export function isCorrelationId(value: unknown): value is CorrelationId;
export function isTimestamp(value: unknown): value is Timestamp;
export function isSha256Hash(value: unknown): value is Sha256Hash;
