import { randomUUID } from "node:crypto";
import type {
  AuditEvent,
  VerificationResult,
} from "@rift/core";
import {
  validateCandidatePatch,
  validateIncidentManifest,
  validateVerificationPlan,
} from "@rift/core";
import { sha256 } from "../domain/hashing.js";
import type {
  CommandOutcome,
  PatchOutcome,
  VerificationAuditSink,
  VerificationConcurrency,
  VerificationControlPlane,
  VerificationReceiptStore,
  VerificationRequest,
  VerificationRun,
  VerificationRunSnapshot,
  VerificationRunner,
  VerificationStage,
  VerificationStageReceipt,
  VerificationState,
  VerificationTransition,
  VerificationWorkspace,
} from "./ports.js";

const TERMINAL: readonly VerificationState[] = ["completed", "cancelled"];
const STAGES: Record<VerificationState, VerificationStage> = {
  queued: "validate",
  validating: "validate",
  "baseline-running": "baseline",
  "baseline-not-reproduced": "baseline",
  "patch-applying": "patch",
  "checks-running": "checks",
  classifying: "classify",
  "cleaning-up": "cleanup",
  completed: "cleanup",
  cancelled: "cleanup",
};
const ALLOWED: Record<VerificationState, readonly VerificationState[]> = {
  queued: ["validating", "cancelled"],
  validating: ["baseline-running", "cleaning-up", "cancelled"],
  "baseline-running": ["baseline-not-reproduced", "patch-applying", "cleaning-up", "cancelled"],
  "baseline-not-reproduced": ["cleaning-up", "cancelled"],
  "patch-applying": ["checks-running", "cleaning-up", "cancelled"],
  "checks-running": ["classifying", "cleaning-up", "cancelled"],
  classifying: ["cleaning-up", "cancelled"],
  "cleaning-up": ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

type JsonRecord = Record<string, unknown>;

export class InMemoryVerificationReceiptStore implements VerificationReceiptStore {
  private readonly receipts = new Map<string, VerificationStageReceipt>();
  public get(key: string): VerificationStageReceipt | undefined { return this.receipts.get(key); }
  public put(receipt: VerificationStageReceipt): void {
    const prior = this.receipts.get(receipt.key);
    if (prior !== undefined && prior.outputHash !== receipt.outputHash) throw new Error("receipt key conflict");
    this.receipts.set(receipt.key, receipt);
  }
}

export class BoundedVerificationConcurrency implements VerificationConcurrency {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  public constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("concurrency limit must be positive");
  }
  public async acquire(signal: AbortSignal): Promise<{ release(): void }> {
    if (signal.aborted) throw abortError();
    if (this.active >= this.limit) await new Promise<void>((resolve, reject) => {
      const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(abortError()); };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(() => { signal.removeEventListener("abort", onAbort); resolve(); });
    });
    this.active += 1;
    let released = false;
    return { release: () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiters.shift()?.();
    } };
  }
  public get activeCount(): number { return this.active; }
}

function abortError(): Error { return Object.assign(new Error("verification cancelled"), { code: "CANCELLED" }); }
function now(): string { return new Date().toISOString(); }
function isRecord(value: unknown): value is JsonRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
function hashValue(value: unknown): string { return sha256(value as never); }
function isOutcome(value: unknown): value is CommandOutcome {
  if (!isRecord(value) || !["succeeded", "failed", "timed-out", "cancelled", "blocked"].includes(String(value.status))) return false;
  return (value.exitCode === null || Number.isSafeInteger(value.exitCode)) && Array.isArray(value.evidenceIds) && value.evidenceIds.every((id) => typeof id === "string" && id.length > 0);
}
function parseBaseline(value: unknown): CommandOutcome {
  if (!isOutcome(value)) throw new Error("MALFORMED_BASELINE_OUTPUT");
  return value;
}
function parsePatch(value: unknown): PatchOutcome {
  if (!isRecord(value) || typeof value.applied !== "boolean" || typeof value.receiptId !== "string" || value.receiptId.length === 0 || !Array.isArray(value.evidenceIds) || !value.evidenceIds.every((id) => typeof id === "string" && id.length > 0)) throw new Error("MALFORMED_PATCH_OUTPUT");
  return value as unknown as PatchOutcome;
}
function parseChecks(value: unknown, expected: number): readonly CommandOutcome[] {
  if (!isRecord(value) || !Array.isArray(value.executions) || value.executions.length !== expected || !value.executions.every(isOutcome)) throw new Error("MALFORMED_CHECK_OUTPUT");
  return value.executions as unknown as readonly CommandOutcome[];
}
function linkedSignal(parent: AbortSignal, controller: AbortController): void {
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener("abort", () => controller.abort(parent.reason), { once: true });
}

export class VerificationOrchestrator implements VerificationControlPlane {
  private readonly runs = new Map<string, RunState>();
  private readonly idempotentRuns = new Map<string, VerificationRun>();
  private readonly idempotencyFingerprints = new Map<string, string>();
  public constructor(
    private readonly runner: VerificationRunner,
    private readonly audit: VerificationAuditSink,
    private readonly concurrency: VerificationConcurrency,
    private readonly receipts: VerificationReceiptStore = new InMemoryVerificationReceiptStore(),
    private readonly cleanupTimeoutMs = 5_000,
    private readonly maxAttempts = 2,
  ) {}

  public start(request: VerificationRequest): VerificationRun {
    const fingerprint = verificationIdempotencyKey(request);
    const existing = this.idempotentRuns.get(request.idempotencyKey);
    if (existing !== undefined) {
      if (this.idempotencyFingerprints.get(request.idempotencyKey) !== fingerprint) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
      return existing;
    }
    const runId = `verification-${randomUUID()}`;
    const controller = new AbortController();
    linkedSignal(request.signal ?? new AbortController().signal, controller);
    const state = new RunState(runId, request, controller);
    this.runs.set(runId, state);
    const run: VerificationRun = { runId, correlationId: request.correlationId, result: this.execute(state), cancel: (reason) => this.cancel(runId, reason) };
    this.idempotentRuns.set(request.idempotencyKey, run);
    this.idempotencyFingerprints.set(request.idempotencyKey, fingerprint);
    return run;
  }

  public async get(runId: string): Promise<VerificationRunSnapshot | undefined> { return this.runs.get(runId)?.snapshot(); }
  public async cancel(runId: string, reason = "cancelled by caller"): Promise<void> {
    const state = this.runs.get(runId);
    if (state === undefined || TERMINAL.includes(state.state)) return;
    state.cancelReason = reason;
    state.controller.abort(reason);
  }

  private async execute(run: RunState): Promise<VerificationResult> {
    let lease: { release(): Promise<void> | void } | undefined;
    let result: VerificationResult | undefined;
    let cleanupFailed = false;
    try {
      this.transition(run, "validating");
      this.validateRequest(run.request);
      await this.sideEffectAudit(run, "verification.stage", "validate", "succeeded", [run.request.plan.contentHash, run.request.patch.contentHash]);
      lease = await this.concurrency.acquire(run.controller.signal);
      this.transition(run, "baseline-running");
      const baselineWorkspace = await this.createWorkspace(run, "baseline");
      run.workspaces.push(baselineWorkspace);
      const baseline = parseBaseline(await this.stage(run, "baseline", "command", () => this.runner.runBaseline({ runId: run.runId, correlationId: run.request.correlationId, manifest: run.request.manifest, plan: run.request.plan, workspace: baselineWorkspace, signal: run.controller.signal })));
      if (run.controller.signal.aborted) throw abortError();
      if (baseline.evidenceIds.length === 0) throw new Error("MISSING_BASELINE_EVIDENCE");
      if (baseline.status !== "failed" && baseline.status !== "succeeded") {
        throw new Error(baseline.failureCode ?? "BASELINE_EXECUTION_UNCERTAIN");
      }
      const reproduced = baseline.status === "failed" && baseline.reproduced === true && (run.request.baselineExpectation?.expectedFailureCode === undefined || baseline.failureCode === run.request.baselineExpectation.expectedFailureCode);
      if (!reproduced) {
        this.transition(run, "baseline-not-reproduced", "BASELINE_NOT_REPRODUCED");
        result = this.makeResult(run, "not-reproduced", baseline.exitCode, null, baseline.evidenceIds);
      } else {
        this.transition(run, "patch-applying");
        const patchedWorkspace = await this.createWorkspace(run, "patched");
        run.workspaces.push(patchedWorkspace);
        const patched = parsePatch(await this.stage(run, "patch", "apply", () => this.runner.applyPatch({ runId: run.runId, correlationId: run.request.correlationId, plan: run.request.plan, patch: run.request.patch, workspace: patchedWorkspace, applicationOrdinal: 1, idempotencyKey: stageKey(run.request.idempotencyKey, "patch:apply"), signal: run.controller.signal })));
        if (!patched.applied) result = this.makeResult(run, patched.failureCode === "PATCH_FAILED" ? "regressed" : "inconclusive", baseline.exitCode, null, [...baseline.evidenceIds, ...patched.evidenceIds], patched.failureCode ?? "PATCH_NOT_APPLIED");
        else if (patched.evidenceIds.length === 0) result = this.makeResult(run, "inconclusive", baseline.exitCode, null, baseline.evidenceIds, "MISSING_PATCH_EVIDENCE");
        else {
          this.transition(run, "checks-running");
          const checks = parseChecks(await this.stage(run, "checks", "commands", () => this.runner.runChecks({ runId: run.runId, correlationId: run.request.correlationId, plan: run.request.plan, workspace: patchedWorkspace, signal: run.controller.signal })), run.request.plan.verificationCommands.length);
          this.transition(run, "classifying");
          const evidenceIds = [...baseline.evidenceIds, ...patched.evidenceIds, ...checks.flatMap((check) => check.evidenceIds)];
          const checkFailure = checks.find((check) => check.status !== "succeeded");
          const classification = checks.some((check) => check.evidenceIds.length === 0) ? "inconclusive" : (checkFailure === undefined ? "verified" : (["timed-out", "cancelled", "blocked"].includes(checkFailure.status) ? "inconclusive" : "regressed"));
          result = this.makeResult(run, classification, baseline.exitCode, checks.every((check) => check.exitCode !== null) ? Math.max(...checks.map((check) => check.exitCode as number)) : null, evidenceIds, checkFailure?.failureCode);
        }
      }
    } catch (error) {
      result = this.makeResult(run, "inconclusive", null, null, [], error instanceof Error ? error.message : "VERIFICATION_FAILED");
    } finally {
      try {
        if (!TERMINAL.includes(run.state)) this.transition(run, "cleaning-up", run.cancelReason ?? undefined);
        const cleanupController = new AbortController();
        const timer = setTimeout(() => cleanupController.abort("cleanup timeout"), this.cleanupTimeoutMs);
        try {
          await this.sideEffectAudit(run, "verification.cleanup", "cleanup", "succeeded", run.workspaces.map((workspace) => hashValue(workspace.id)));
          await this.runner.cleanup({ runId: run.runId, correlationId: run.request.correlationId, workspaces: run.workspaces, signal: cleanupController.signal });
          await this.sideEffectAudit(run, "verification.cleanup", "cleanup", "succeeded", run.workspaces.map((workspace) => hashValue(workspace.id)));
        } finally { clearTimeout(timer); }
      } catch (error) {
        cleanupFailed = true;
        await this.safeAudit(run, "verification.cleanup", "cleanup", "failed", [], [], error instanceof Error ? error.message : "CLEANUP_FAILED");
      } finally {
        if (lease !== undefined) await lease.release();
      }
    }
    return await this.finish(run, result ?? this.makeResult(run, "inconclusive", null, null, [], "NO_RESULT"), cleanupFailed);
  }

  private async finish(run: RunState, initial: VerificationResult, cleanupAlreadyFailed: boolean): Promise<VerificationResult> {
    let result = initial;
    if (cleanupAlreadyFailed || run.controller.signal.aborted) result = this.makeResult(run, "inconclusive", result.baselineExitCode, result.patchedExitCode, result.evidenceIds, cleanupAlreadyFailed ? "CLEANUP_FAILED" : "CANCELLED");
    run.result = result;
    this.transition(run, run.controller.signal.aborted ? "cancelled" : "completed", result.classification);
    return result;
  }

  private validateRequest(request: VerificationRequest): void {
    if (request.correlationId !== request.manifest.correlationId || request.correlationId !== request.plan.correlationId || request.correlationId !== request.patch.correlationId) throw new Error("CORRELATION_ID_MISMATCH");
    if (request.plan.candidatePatchId !== request.patch.id || JSON.stringify(request.plan.baseRevision) !== JSON.stringify(request.patch.baseRevision) || JSON.stringify(request.plan.baseRevision) !== JSON.stringify(request.manifest.repositoryRevision)) throw new Error("REVISION_OR_PATCH_MISMATCH");
    if (!validateIncidentManifest(request.manifest).ok || !validateVerificationPlan(request.plan).ok || !validateCandidatePatch(request.patch).ok) throw new Error("INVALID_VERIFICATION_INPUT");
    if (!/^sha256:[0-9a-f]{64}$/u.test(request.idempotencyKey)) throw new Error("INVALID_IDEMPOTENCY_KEY");
  }

  private async createWorkspace(run: RunState, phase: "baseline" | "patched"): Promise<VerificationWorkspace> {
    const value = await this.stage(run, "baseline", `workspace-${phase}`, () => this.runner.createWorkspace({ runId: run.runId, correlationId: run.request.correlationId, manifest: run.request.manifest, plan: run.request.plan, phase, signal: run.controller.signal }));
    if (!isRecord(value) || typeof value.id !== "string" || value.phase !== phase) throw new Error("MALFORMED_WORKSPACE_OUTPUT");
    return value as unknown as VerificationWorkspace;
  }

  private async stage<T>(run: RunState, stage: VerificationStage, suffix: string, operation: () => Promise<T>): Promise<T> {
    const key = stageKey(run.request.idempotencyKey, `${stage}:${suffix}`);
    const prior = await this.receipts.get(key);
    if (prior !== undefined) throw new Error("RECEIPT_REQUIRES_WORKER_RECONCILIATION");
    const attempts = stage === "patch" ? 1 : this.maxAttempts;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      run.attempt = attempt;
      await this.sideEffectAudit(run, "verification.execute", stage, "succeeded", [hashValue(key)]);
      try {
        const value = await operation();
        await this.receipts.put({ key, outputHash: hashValue(value) });
        await this.sideEffectAudit(run, "verification.execute", stage, "succeeded", [hashValue(key)], [hashValue(value)]);
        return value;
      } catch (error) {
        const code = error instanceof Error ? error.message : "STAGE_FAILED";
        if (attempt < attempts && !run.controller.signal.aborted) {
          await this.safeAudit(run, "verification.retry", stage, "failed", [hashValue(key)], [], code);
          continue;
        }
        await this.safeAudit(run, "verification.execute", stage, "failed", [hashValue(key)], [], code);
        throw error;
      }
    }
    throw new Error("STAGE_RETRY_EXHAUSTED");
  }

  private makeResult(run: RunState, classification: VerificationResult["classification"], baselineExitCode: number | null, patchedExitCode: number | null, evidenceIds: readonly string[], failureCode?: string): VerificationResult {
    const withoutHash = { kind: "VerificationResult" as const, schemaVersion: 1 as const, id: `result-${run.runId}`, incidentId: run.request.manifest.incidentId, correlationId: run.request.correlationId, createdAt: now(), verificationPlanId: run.request.plan.id, classification, baselineExitCode, patchedExitCode, evidenceIds, ...(failureCode === undefined ? {} : { failure: { code: failureCode, message: failureCode } }) };
    return { ...withoutHash, contentHash: hashValue(withoutHash) } as VerificationResult;
  }

  private transition(run: RunState, to: VerificationState, reasonCode?: string): void {
    if (run.state === to) return;
    if (!ALLOWED[run.state].includes(to)) throw new Error(`INVALID_TRANSITION:${run.state}:${to}`);
    const transition: VerificationTransition = { runId: run.runId, incidentId: run.request.manifest.incidentId, correlationId: run.request.correlationId, from: run.state, to, stage: STAGES[to], attempt: run.attempt, occurredAt: now(), ...(reasonCode === undefined ? {} : { reasonCode }) };
    run.state = to;
    run.transitions.push(transition);
    void this.sideEffectAudit(run, "verification.stage", transition.stage, "succeeded", [hashValue(transition)]).catch(() => undefined);
  }

  private async sideEffectAudit(run: RunState, action: AuditEvent["action"], stage: VerificationStage, outcome: "succeeded" | "failed" | "denied", inputHashes: readonly string[], outputHashes: readonly string[] = []): Promise<void> {
    const eventBase = { kind: "AuditEvent" as const, schemaVersion: 1 as const, id: `audit-${randomUUID()}`, incidentId: run.request.manifest.incidentId, correlationId: run.request.correlationId, createdAt: now(), occurredAt: now(), actor: { kind: "system" as const, id: "verification-control-plane" }, action, policyDecision: { outcome: "allowed" as const, policyId: "verification-policy-v1", reasonCode: "explicitly-authorized" }, result: outcome, inputHashes, outputHashes, stage, attempt: run.attempt };
    const event = { ...eventBase, contentHash: hashValue(eventBase) } as AuditEvent;
    await this.audit.append(event);
  }
  private async safeAudit(run: RunState, action: AuditEvent["action"], stage: VerificationStage, outcome: "failed" | "denied", inputHashes: readonly string[], outputHashes: readonly string[], code: string): Promise<void> {
    try { await this.audit.append({ kind: "AuditEvent", schemaVersion: 1, id: `audit-${randomUUID()}`, incidentId: run.request.manifest.incidentId, correlationId: run.request.correlationId, createdAt: now(), occurredAt: now(), actor: { kind: "system", id: "verification-control-plane" }, action, policyDecision: { outcome: "allowed", policyId: "verification-policy-v1", reasonCode: "side-effect-failed" }, result: outcome, inputHashes, outputHashes, stage, attempt: run.attempt, failure: { code }, contentHash: hashValue({ code, action, stage, inputHashes, outputHashes }) } as AuditEvent); } catch { /* audit failure is reflected by the inconclusive result */ }
  }
}

class RunState {
  public state: VerificationState = "queued";
  public attempt = 1;
  public cancelReason: string | undefined;
  public result: VerificationResult | undefined;
  public readonly transitions: VerificationTransition[] = [];
  public readonly workspaces: VerificationWorkspace[] = [];
  public constructor(public readonly runId: string, public readonly request: VerificationRequest, public readonly controller: AbortController) {}
  public snapshot(): VerificationRunSnapshot { return { runId: this.runId, incidentId: this.request.manifest.incidentId, correlationId: this.request.correlationId, state: this.state, stage: STAGES[this.state], attempt: this.attempt, transitions: [...this.transitions], ...(this.result === undefined ? {} : { result: this.result }) }; }
}

function stageKey(runKey: string, stage: string): string { return hashValue({ runKey, stage } as never); }

export function verificationIdempotencyKey(input: Pick<VerificationRequest, "manifest" | "plan" | "patch" | "correlationId">): string {
  return sha256(JSON.stringify({ incidentId: input.manifest?.incidentId, correlationId: input.correlationId, plan: input.plan?.contentHash, patch: input.patch?.contentHash, policy: input.manifest?.policy ?? {} }) as never);
}
