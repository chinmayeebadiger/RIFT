/**
 * JSON-compatible values used by Rift's domain contracts.
 *
 * Contracts deliberately use plain data rather than Dates, Maps, or class
 * instances so they can be persisted, hashed, and sent over an API unchanged.
 * Runtime validation lives in validators.ts; these types do not imply that
 * untrusted JSON has already been checked.
 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** M1 contract version. New versions must remain additive or be migrated. */
export const CONTRACT_SCHEMA_VERSION = 1 as const;
export const M1_SCHEMA_VERSION = CONTRACT_SCHEMA_VERSION;
export type ContractSchemaVersion = typeof CONTRACT_SCHEMA_VERSION;
export type SchemaVersion = ContractSchemaVersion;

/** String aliases keep the wire contracts ergonomic while validators enforce their syntax. */
export type IncidentId = string;
export type ManifestId = string;
export type EvidenceId = string;
export type AuditEventId = string;
export type CorrelationId = string;
export type Timestamp = string;
export type Sha256Hash = string;

export interface VersionedContract {
  readonly schemaVersion: ContractSchemaVersion;
  readonly id: string;
  readonly incidentId: string;
  readonly correlationId: string;
  readonly createdAt: string;
  /** Hash of the serialized contract payload, excluding this field. */
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

/**
 * Policy is intentionally explicit and bounded. Policy enforcement belongs to
 * intake, while this contract preserves the selected policy for a run.
 */
export interface IncidentPolicy {
  readonly networkAccess?: "disabled" | "allowlisted";
  readonly allowedCommands?: readonly string[];
  readonly maxEvidenceBytes?: number;
  readonly redactSecrets?: boolean;
  readonly [key: string]: JsonValue | undefined;
}

/** The serializable incident bundle accepted by the M1 intake boundary. */
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

export interface EvidenceSource {
  readonly type: string;
  readonly locator: string;
}

export interface EvidenceRedaction {
  readonly status: EvidenceRedactionStatus;
  readonly rules?: readonly string[];
}

/** Provenance is intentionally structured instead of an opaque metadata bag. */
export interface Provenance {
  readonly actor: string;
  readonly tool?: string;
  readonly sourceHash?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export type EvidenceProvenance = Provenance;

/** An immutable, content-addressed observation associated with an incident. */
export interface EvidenceItem extends VersionedContract {
  readonly kind: "EvidenceItem";
  readonly content: JsonValue;
  readonly source: EvidenceSource;
  readonly capturedAt: string;
  readonly redaction: EvidenceRedaction;
  readonly provenance: Provenance;
}

export type AuditActorKind = "system" | "human" | "worker" | "model";
export type AuditAction =
  | "intake.validate"
  | "evidence.import"
  | "policy.evaluate"
  | "model.call"
  | "sandbox.create"
  | "external.action";
export type AuditResult = "succeeded" | "failed" | "denied";

/** Append-only record of a policy-relevant action or attempted action. */
export interface AuditEvent extends VersionedContract {
  readonly kind: "AuditEvent";
  readonly occurredAt: string;
  readonly actor: {
    readonly kind: AuditActorKind;
    readonly id: string;
  };
  readonly action: AuditAction;
  readonly policyDecision: {
    readonly outcome: "allowed" | "denied";
    readonly policyId: string;
    readonly reasonCode: string;
  };
  readonly result: AuditResult;
  readonly inputHashes: readonly string[];
  readonly outputHashes: readonly string[];
  readonly failure?: {
    readonly code: string;
  };
}
