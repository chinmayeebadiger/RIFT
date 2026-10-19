import type { EvidenceItem, JsonValue, Sha256Hash } from "../domain/contracts.js";
import type { EvidenceStore } from "../domain/evidence-store.js";
import { sha256 } from "../domain/hashing.js";

export interface RetentionPolicy {
  readonly policyId: string;
  /** Evidence older than this duration is eligible for logical purge. */
  readonly retentionMs: number;
  /** The evidence timestamp used for the retention decision. */
  readonly timestampField?: "createdAt" | "capturedAt";
}

export interface RetentionPlanOptions {
  /** Required to make a plan reproducible and safe to review before execution. */
  readonly asOf: string;
}

export interface RetentionPlanEntry {
  readonly evidenceId: string;
  readonly contentHash: Sha256Hash;
  readonly timestamp: string;
  readonly disposition: "purge" | "protected";
}

export interface RetentionPurgePlan {
  readonly kind: "RetentionPurgePlan";
  readonly dryRun: true;
  readonly policyId: string;
  readonly evaluatedAt: string;
  readonly cutoff: string;
  readonly timestampField: "createdAt" | "capturedAt";
  readonly entries: readonly RetentionPlanEntry[];
  readonly purgeEvidenceIds: readonly string[];
  readonly protectedEvidenceIds: readonly string[];
  readonly planHash: Sha256Hash;
}

export interface PurgeAuthorization {
  /** Must be true at the call site; omitting authorization is never sufficient. */
  readonly authorized: boolean;
  readonly actor: string;
  readonly reason?: string;
  /** Optional explicit execution time. Defaults to the plan evaluation time. */
  readonly executedAt?: string;
}

export interface RetentionPurgeReceipt {
  readonly kind: "RetentionPurgeReceipt";
  readonly status: "completed";
  readonly appendOnly: true;
  readonly authorized: true;
  readonly receiptId: Sha256Hash;
  readonly receiptHash: Sha256Hash;
  readonly policyId: string;
  readonly actor: string;
  readonly reason?: string;
  readonly executedAt: string;
  readonly cutoff: string;
  readonly planHash: Sha256Hash;
  readonly purgedEvidenceIds: readonly string[];
  readonly protectedEvidenceIds: readonly string[];
}

export class RetentionPolicyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RetentionPolicyError";
  }
}

export class RetentionAuthorizationError extends Error {
  public constructor(message = "Retention purge requires explicit authorization and actor") {
    super(message);
    this.name = "RetentionAuthorizationError";
  }
}

export class RetentionPlanError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RetentionPlanError";
  }
}

function parseTimestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new RetentionPolicyError(`${field} must be an ISO timestamp`);
  return parsed;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function hashObject(value: object): Sha256Hash {
  return sha256(value as unknown as JsonValue);
}

/** Verify the content-addressed identity of a dry-run plan. */
export function verifyRetentionPlan(plan: RetentionPurgePlan): boolean {
  const { planHash, ...withoutHash } = plan;
  return planHash === hashObject(withoutHash);
}

/** Verify both the receipt identity and its tamper-evident content hash. */
export function verifyRetentionPurgeReceipt(receipt: RetentionPurgeReceipt): boolean {
  const { receiptId, receiptHash, ...withoutIds } = receipt;
  const expectedReceiptId = hashObject(withoutIds);
  const { receiptHash: _ignored, ...withoutHash } = receipt;
  return receiptId === expectedReceiptId && receiptHash === hashObject(withoutHash);
}

/**
 * Retention control for an append-only EvidenceStore.
 *
 * Purging is deliberately logical: the source store is never rewritten or
 * deleted from. The manager records authorized purges and can expose a view
 * with those evidence IDs filtered out. A durable implementation can persist
 * the returned receipt as an append-only audit record.
 */
export class RetentionManager {
  private readonly purgedEvidenceIds = new Set<string>();

  public constructor(
    private readonly store: EvidenceStore,
    private readonly policy: RetentionPolicy,
  ) {
    this.validatePolicy();
  }

  public createDryRunPlan(options: RetentionPlanOptions): RetentionPurgePlan {
    return this.plan(options);
  }

  public plan(options: RetentionPlanOptions): RetentionPurgePlan {
    const evaluatedAtMs = parseTimestamp(options.asOf, "asOf");
    const timestampField = this.policy.timestampField ?? "createdAt";
    const cutoffMs = evaluatedAtMs - this.policy.retentionMs;
    const cutoff = new Date(cutoffMs).toISOString();
    const entries = this.store
      .list()
      .filter((item) => !this.purgedEvidenceIds.has(item.id))
      .map((item) => this.toPlanEntry(item, timestampField, cutoffMs))
      .sort((left, right) => {
        const timestampOrder = left.timestamp.localeCompare(right.timestamp);
        if (timestampOrder !== 0) return timestampOrder;
        return left.evidenceId.localeCompare(right.evidenceId);
      });
    const purgeEvidenceIds = entries.filter((entry) => entry.disposition === "purge").map((entry) => entry.evidenceId);
    const protectedEvidenceIds = entries
      .filter((entry) => entry.disposition === "protected")
      .map((entry) => entry.evidenceId);
    const withoutHash = {
      kind: "RetentionPurgePlan" as const,
      dryRun: true as const,
      policyId: this.policy.policyId,
      evaluatedAt: options.asOf,
      cutoff,
      timestampField,
      entries,
      purgeEvidenceIds,
      protectedEvidenceIds,
    };

    return {
      ...withoutHash,
      planHash: hashObject(withoutHash),
    };
  }

  public purge(plan: RetentionPurgePlan, authorization: PurgeAuthorization): RetentionPurgeReceipt {
    if (!authorization || authorization.authorized !== true || typeof authorization.actor !== "string" || authorization.actor.trim() === "") {
      throw new RetentionAuthorizationError();
    }
    if (!plan.dryRun || plan.policyId !== this.policy.policyId || !verifyRetentionPlan(plan)) {
      throw new RetentionPlanError("Retention purge plan is invalid or does not belong to this policy");
    }

    const executedAt = authorization.executedAt ?? plan.evaluatedAt;
    parseTimestamp(executedAt, "executedAt");
    for (const entry of plan.entries) {
      const current = this.store.get(entry.evidenceId);
      if (current === undefined || current.contentHash !== entry.contentHash) {
        throw new RetentionPlanError(`Evidence changed or disappeared since planning: ${entry.evidenceId}`);
      }
      const currentTimestamp = current[this.policy.timestampField ?? "createdAt"];
      if (entry.disposition === "purge" && !(parseTimestamp(currentTimestamp, "evidence timestamp") < parseTimestamp(plan.cutoff, "cutoff"))) {
        throw new RetentionPlanError(`Evidence is protected by the current cutoff: ${entry.evidenceId}`);
      }
    }

    const purgedEvidenceIds = plan.purgeEvidenceIds.filter((id) => !this.purgedEvidenceIds.has(id));
    for (const evidenceId of purgedEvidenceIds) this.purgedEvidenceIds.add(evidenceId);
    const withoutIds = {
      kind: "RetentionPurgeReceipt" as const,
      status: "completed" as const,
      appendOnly: true as const,
      authorized: true as const,
      policyId: plan.policyId,
      actor: authorization.actor,
      ...(authorization.reason === undefined ? {} : { reason: authorization.reason }),
      executedAt,
      cutoff: plan.cutoff,
      planHash: plan.planHash,
      purgedEvidenceIds,
      protectedEvidenceIds: plan.protectedEvidenceIds,
    };
    const receiptId = hashObject(withoutIds);
    const withId = { ...withoutIds, receiptId };
    return {
      ...withId,
      receiptHash: hashObject(withId),
    };
  }

  /** Return the logical retained view without mutating the append-only store. */
  public listRetained(): readonly EvidenceItem[] {
    return this.store.list().filter((item) => !this.purgedEvidenceIds.has(item.id)).map((item) => clone(item));
  }

  public isPurged(evidenceId: string): boolean {
    return this.purgedEvidenceIds.has(evidenceId);
  }

  private validatePolicy(): void {
    if (this.policy.policyId.trim() === "") throw new RetentionPolicyError("policyId must not be empty");
    if (!Number.isSafeInteger(this.policy.retentionMs) || this.policy.retentionMs <= 0) {
      throw new RetentionPolicyError("retentionMs must be a positive safe integer");
    }
  }

  private toPlanEntry(item: EvidenceItem, timestampField: "createdAt" | "capturedAt", cutoffMs: number): RetentionPlanEntry {
    const timestamp = item[timestampField];
    const timestampMs = parseTimestamp(timestamp, `evidence ${item.id} timestamp`);
    return {
      evidenceId: item.id,
      contentHash: item.contentHash,
      timestamp,
      disposition: timestampMs < cutoffMs ? "purge" : "protected",
    };
  }
}

export const RetentionPolicyManager = RetentionManager;
