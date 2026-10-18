import type {
  AuditEvent,
  CandidatePatch,
  CorrelationId,
  IncidentManifest,
  VerificationPlan,
  VerificationResult,
} from "@rift/core";

export type VerificationStage = "validate" | "baseline" | "patch" | "checks" | "classify" | "cleanup";
export type VerificationState =
  | "queued"
  | "validating"
  | "baseline-running"
  | "baseline-not-reproduced"
  | "patch-applying"
  | "checks-running"
  | "classifying"
  | "cleaning-up"
  | "completed"
  | "cancelled";

export interface VerificationRequest {
  readonly manifest: IncidentManifest;
  readonly plan: VerificationPlan;
  readonly patch: CandidatePatch;
  readonly baselineExpectation?: { readonly expectedFailureCode?: string };
  readonly correlationId: CorrelationId;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
}

export interface VerificationTransition {
  readonly runId: string;
  readonly incidentId: string;
  readonly correlationId: CorrelationId;
  readonly from: VerificationState | null;
  readonly to: VerificationState;
  readonly stage: VerificationStage;
  readonly attempt: number;
  readonly occurredAt: string;
  readonly reasonCode?: string;
}

export interface VerificationRunSnapshot {
  readonly runId: string;
  readonly incidentId: string;
  readonly correlationId: CorrelationId;
  readonly state: VerificationState;
  readonly stage: VerificationStage;
  readonly attempt: number;
  readonly transitions: readonly VerificationTransition[];
  readonly result?: VerificationResult;
}

export interface VerificationRun {
  readonly runId: string;
  readonly correlationId: CorrelationId;
  readonly result: Promise<VerificationResult>;
  cancel(reason?: string): Promise<void>;
}

export interface VerificationWorkspace {
  readonly id: string;
  readonly phase: "baseline" | "patched";
}

export interface CommandOutcome {
  readonly status: "succeeded" | "failed" | "timed-out" | "cancelled" | "blocked";
  readonly exitCode: number | null;
  readonly evidenceIds: readonly string[];
  readonly reproduced?: boolean;
  readonly failureCode?: string;
}

export interface PatchOutcome {
  readonly applied: boolean;
  readonly receiptId: string;
  readonly evidenceIds: readonly string[];
  readonly failureCode?: string;
}

export interface ChecksOutcome {
  readonly executions: readonly CommandOutcome[];
}

export interface VerificationRunner {
  createWorkspace(request: {
    readonly runId: string;
    readonly correlationId: CorrelationId;
    readonly manifest: IncidentManifest;
    readonly plan: VerificationPlan;
    readonly phase: "baseline" | "patched";
    readonly signal: AbortSignal;
  }): Promise<unknown>;
  runBaseline(request: {
    readonly runId: string;
    readonly correlationId: CorrelationId;
    readonly manifest: IncidentManifest;
    readonly plan: VerificationPlan;
    readonly workspace: VerificationWorkspace;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
  applyPatch(request: {
    readonly runId: string;
    readonly correlationId: CorrelationId;
    readonly plan: VerificationPlan;
    readonly patch: CandidatePatch;
    readonly workspace: VerificationWorkspace;
    readonly applicationOrdinal: 1;
    readonly idempotencyKey: string;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
  runChecks(request: {
    readonly runId: string;
    readonly correlationId: CorrelationId;
    readonly plan: VerificationPlan;
    readonly workspace: VerificationWorkspace;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
  cleanup(request: {
    readonly runId: string;
    readonly correlationId: CorrelationId;
    readonly workspaces: readonly VerificationWorkspace[];
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

export interface VerificationAuditSink {
  append(event: AuditEvent): Promise<void> | void;
}

export interface VerificationStageReceipt {
  readonly key: string;
  readonly outputHash: string;
}

export interface VerificationReceiptStore {
  get(key: string): Promise<VerificationStageReceipt | undefined> | VerificationStageReceipt | undefined;
  put(receipt: VerificationStageReceipt): Promise<void> | void;
}

export interface VerificationConcurrency {
  acquire(signal: AbortSignal): Promise<{ release(): Promise<void> | void }>;
}

export interface VerificationControlPlane {
  start(request: VerificationRequest): VerificationRun;
  get(runId: string): Promise<VerificationRunSnapshot | undefined>;
  cancel(runId: string, reason?: string): Promise<void>;
}
