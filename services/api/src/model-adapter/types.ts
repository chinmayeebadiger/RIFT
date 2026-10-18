import type {
  CandidatePatch,
  CorrelationId,
  IncidentId,
  RepositoryRevision,
  Sha256Hash,
  Timestamp,
} from "@rift/core";

export interface CandidatePatchModelInput {
  readonly schemaVersion: 1;
  readonly incidentId: IncidentId;
  readonly correlationId: CorrelationId;
  readonly createdAt: Timestamp;
  readonly repositoryRevision: RepositoryRevision;
  readonly hypothesisId: string;
  /** A redaction-safe summary, never raw evidence or source contents. */
  readonly hypothesisSummary: string;
  readonly targetPath: string;
  /** Hash of the versioned, redaction-safe input fixture. */
  readonly inputHash: Sha256Hash;
}

export interface CandidatePatchPolicy {
  readonly authorized: boolean;
  readonly incidentId: IncidentId;
  readonly repositoryRevision: RepositoryRevision;
  readonly hypothesisId: string;
  readonly allowedPaths: readonly string[];
  /** The only actor the provider is permitted to claim in its proposal. */
  readonly actor: "fake-model" | "gpt-6-astra";
  readonly maxDiffBytes?: number;
  readonly maxTouchedPaths?: number;
}

export interface CandidatePatchRequest {
  readonly modelInput: CandidatePatchModelInput;
  readonly policy: CandidatePatchPolicy;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** A provider receives only serialized, redaction-safe data and cancellation. */
export interface CandidatePatchProvider {
  readonly name: string;
  generate(input: string, signal: AbortSignal): Promise<unknown>;
}

export interface ModelAdapterOptions {
  readonly defaultTimeoutMs?: number;
  readonly maxTimeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface ModelAdapterFailureIssue {
  readonly path: string;
  readonly code: string;
}

export class ModelAdapterError extends Error {
  public readonly code:
    | "INVALID_REQUEST"
    | "SECRET_INPUT"
    | "POLICY_DENIED"
    | "MALFORMED_OUTPUT"
    | "SCHEMA_INVALID"
    | "OUTPUT_REJECTED"
    | "TIMEOUT"
    | "CANCELLED"
    | "PROVIDER_ERROR";
  public readonly issues: readonly ModelAdapterFailureIssue[];

  public constructor(
    code: ModelAdapterError["code"],
    message: string,
    issues: readonly ModelAdapterFailureIssue[] = [],
  ) {
    super(message);
    this.name = "ModelAdapterError";
    this.code = code;
    this.issues = issues;
  }
}

export interface CandidatePatchAdapter {
  propose(request: CandidatePatchRequest): Promise<CandidatePatch>;
}
