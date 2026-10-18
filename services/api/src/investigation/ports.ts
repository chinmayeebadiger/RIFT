import type {
  CommandExecution,
  CommandSpec,
  CorrelationId,
  EvidenceItem,
  EvidenceCitation,
  HypothesisEvidence,
  HypothesisSet,
  IncidentId,
  IncidentManifest,
  InvestigationTimeline,
  LogNormalization,
  RepositoryRevision,
  RepositorySnapshotId,
  RepositorySnapshot,
  Timestamp,
  TimelineCertainty,
} from "@rift/core";

/** Capabilities are explicit inputs; ports must not infer authority from process state. */
export interface RepositoryReadCapability {
  readonly repositoryRevision: RepositoryRevision;
  readonly allowedPaths: readonly string[];
}

export interface CommandExecutionCapability {
  readonly allowedCommands: readonly string[];
  readonly networkAccess: "disabled" | "allowlisted";
  readonly timeoutMs: number;
}

export interface InvestigationPortContext {
  readonly incidentId: IncidentId;
  readonly correlationId: CorrelationId;
  readonly signal?: AbortSignal;
}

export interface RepositorySnapshotRequest extends InvestigationPortContext {
  readonly repositoryRevision: RepositoryRevision;
  readonly capability: RepositoryReadCapability;
}

/**
 * Reads a pinned, allowlisted source view. The result is unknown because worker
 * output crosses a trust boundary and must be validated by the control plane.
 */
export interface RepositorySnapshotReader {
  read(request: RepositorySnapshotRequest): Promise<unknown>;
}

export interface CommandExecutionRequest extends InvestigationPortContext {
  readonly snapshotId: RepositorySnapshotId;
  readonly command: CommandSpec;
  readonly capability: CommandExecutionCapability;
}

/** Executes one bounded command without mutating the user's working tree. */
export interface CommandExecutor {
  execute(request: CommandExecutionRequest): Promise<unknown>;
}

export interface LogNormalizationInput {
  readonly evidence: EvidenceItem;
  readonly content: string;
}

export interface LogNormalizationRequest extends InvestigationPortContext {
  readonly inputs: readonly LogNormalizationInput[];
}

/** Preserves source evidence while producing bounded normalized observations. */
export interface LogNormalizer {
  normalize(request: LogNormalizationRequest): Promise<unknown>;
}

export interface TimelineObservation {
  readonly occurredAt?: Timestamp;
  readonly kind: "observation" | "failure" | "command" | "commit" | "hypothesis" | "unknown";
  readonly certainty: TimelineCertainty;
  readonly summary: string;
  readonly citations: readonly EvidenceCitation[];
}

export interface TimelineBuildRequest extends InvestigationPortContext {
  readonly observations: readonly TimelineObservation[];
}

/** Produces stable sequence ordering; it does not read repositories or execute commands. */
export interface TimelineBuilder {
  build(request: TimelineBuildRequest): Promise<unknown>;
}

export interface HypothesisEngineRequest extends InvestigationPortContext {
  readonly manifest: IncidentManifest;
  readonly snapshot: RepositorySnapshot;
  readonly executions: readonly CommandExecution[];
  readonly normalization: readonly LogNormalization[];
  readonly timeline: InvestigationTimeline;
  readonly evidence: readonly EvidenceItem[];
}

export interface HypothesisEngineOutput {
  readonly hypothesisSet: HypothesisSet;
  readonly hypothesisEvidence: readonly HypothesisEvidence[];
}

/** Produces untrusted, evidence-citing hypotheses without invoking tools. */
export interface HypothesisEngine {
  investigate(request: HypothesisEngineRequest): Promise<unknown>;
}

export interface InvestigationResultRequest extends InvestigationPortContext {
  readonly manifest: IncidentManifest;
  readonly snapshot: RepositorySnapshot;
  readonly executions: readonly CommandExecution[];
  readonly normalization: readonly LogNormalization[];
  readonly timeline: InvestigationTimeline;
  readonly evidence: readonly EvidenceItem[];
  readonly hypothesisSet: HypothesisSet;
  readonly hypothesisEvidence: readonly HypothesisEvidence[];
}

/** Assembles and validates the complete M2 result; it does not generate patches. */
export interface InvestigationResultAssembler {
  assemble(request: InvestigationResultRequest): Promise<unknown>;
}
