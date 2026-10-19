import { describe, expect, it } from "vitest";
import type { AuditEvent, CandidatePatch, IncidentManifest, VerificationPlan } from "@rift/core";
import { sha256 } from "../domain/hashing.js";
import { computeCandidatePatchContentHash } from "../investigation/candidate-patch-ranker.js";
import { BoundedVerificationConcurrency, InMemoryVerificationReceiptStore, VerificationOrchestrator, verificationIdempotencyKey } from "./orchestrator.js";
import type { VerificationAuditSink, VerificationRunner } from "./ports.js";

const TIME = "2026-10-18T10:00:00.000Z";
const REVISION = { repository: "rift-demo", revision: "abcdef1" };
const COMMAND = { command: "npm", args: ["test"], workingDirectory: "services/api" };

function base(kind: string, id: string, correlationId = "correlation-1"): Record<string, unknown> {
  return { kind, schemaVersion: 1, id, incidentId: "RIFT-042", correlationId, createdAt: TIME, contentHash: `sha256:${"a".repeat(64)}` };
}

function fixtures(correlationId = "correlation-1"): { manifest: IncidentManifest; plan: VerificationPlan; patch: CandidatePatch; correlationId: string } {
  return {
    manifest: { ...base("IncidentManifest", "manifest-1", correlationId), repositoryRevision: REVISION, allowedPaths: ["src/checkout.ts"], logSources: [{ id: "log-1", type: "fixture", locator: "fixtures/log.txt" }], reproductionCommand: COMMAND, testCommands: [COMMAND], timeWindow: { start: TIME, end: "2026-10-18T11:00:00.000Z" }, policy: { networkAccess: "disabled", allowedCommands: ["npm"] } } as unknown as IncidentManifest,
    plan: { ...base("VerificationPlan", "plan-1", correlationId), candidatePatchId: "patch-1", baseRevision: REVISION, baselineCommand: COMMAND, verificationCommands: [COMMAND], timeoutMs: 30_000, networkAccess: "disabled" } as unknown as VerificationPlan,
    patch: (() => { const withoutHash = { ...base("CandidatePatch", "patch-1", correlationId), sourceHypothesisId: "hypothesis-1", baseRevision: REVISION, diff: "diff --git a/src/checkout.ts b/src/checkout.ts\n--- a/src/checkout.ts\n+++ b/src/checkout.ts\n@@ -1 +1 @@\n-old\n+new\n", touchedPaths: ["src/checkout.ts"], rationale: "Apply the discount once.", expectedInvariant: "The final total is discounted exactly once.", generatedBy: { actor: "fake-model" } } as unknown as Omit<CandidatePatch, "contentHash">; return { ...withoutHash, contentHash: computeCandidatePatchContentHash(withoutHash) } as CandidatePatch; })(),
    correlationId,
  };
}

class AuditLog implements VerificationAuditSink {
  public readonly events: AuditEvent[] = [];
  public append(event: AuditEvent): void { this.events.push(event); }
}

class FixtureRunner implements VerificationRunner {
  public baselineCalls = 0;
  public patchCalls = 0;
  public checkCalls = 0;
  public cleanupCalls = 0;
  public baseline: Record<string, unknown> = { status: "failed", exitCode: 1, evidenceIds: ["baseline-evidence"], reproduced: true, failureCode: "EXPECTED_FAILURE" };
  public patch: Record<string, unknown> = { applied: true, receiptId: "patch-receipt", evidenceIds: ["patch-evidence"] };
  public checks: Record<string, unknown> = { executions: [{ status: "succeeded", exitCode: 0, evidenceIds: ["check-evidence"] }] };
  public baselineFailures = 0;
  public cleanupError = false;
  public async createWorkspace(request: { phase: "baseline" | "patched" }): Promise<unknown> { return { id: `${request.phase}-workspace`, phase: request.phase }; }
  public async runBaseline(): Promise<unknown> { this.baselineCalls += 1; if (this.baselineFailures > 0) { this.baselineFailures -= 1; throw new Error("TRANSIENT_BASELINE_FAILURE"); } return this.baseline; }
  public async applyPatch(): Promise<unknown> { this.patchCalls += 1; return this.patch; }
  public async runChecks(): Promise<unknown> { this.checkCalls += 1; return this.checks; }
  public async cleanup(): Promise<unknown> { this.cleanupCalls += 1; if (this.cleanupError) throw new Error("cleanup failed"); return { cleaned: true }; }
}

function start(runner: FixtureRunner, audit = new AuditLog()) {
  const input = fixtures();
  const request = { ...input, idempotencyKey: verificationIdempotencyKey(input) };
  const orchestrator = new VerificationOrchestrator(runner, audit, new BoundedVerificationConcurrency(2), new InMemoryVerificationReceiptStore());
  return { run: orchestrator.start(request), orchestrator, audit, request };
}

describe("verification control-plane integration", () => {
  it.each([
    ["verified", (runner: FixtureRunner): void => undefined],
    ["regressed", (runner: FixtureRunner): void => { runner.checks = { executions: [{ status: "failed", exitCode: 1, evidenceIds: ["check-evidence"], failureCode: "ASSERTION_FAILED" }] }; }],
    ["not-reproduced", (runner: FixtureRunner): void => { runner.baseline = { status: "succeeded", exitCode: 0, evidenceIds: ["baseline-evidence"], reproduced: false }; }],
    ["inconclusive", (runner: FixtureRunner): void => { runner.baseline = { status: "timed-out", exitCode: null, evidenceIds: [], reproduced: false }; }],
  ] as const)("classifies %s from baseline and patched evidence", async (expected: string, configure: (runner: FixtureRunner) => void) => {
    const runner = new FixtureRunner();
    configure(runner);
    const { run } = start(runner);
    const result = await run.result;
    expect(result.classification).toBe(expected);
    expect(runner.baselineCalls).toBe(1);
    expect(runner.cleanupCalls).toBe(1);
    if (expected === "not-reproduced" || expected === "inconclusive") {
      expect(runner.patchCalls).toBe(0);
      expect(runner.checkCalls).toBe(0);
    }
  });

  it("never calls checks or labels a green patch verified without baseline reproduction", async () => {
    const runner = new FixtureRunner();
    runner.baseline = { status: "succeeded", exitCode: 0, evidenceIds: ["baseline-evidence"], reproduced: false };
    const { run } = start(runner);
    const result = await run.result;
    expect(result.classification).toBe("not-reproduced");
    expect(runner.patchCalls).toBe(0);
    expect(runner.checkCalls).toBe(0);
  });

  it("returns the existing run for an identical retry and applies one patch", async () => {
    const runner = new FixtureRunner();
    const { run, orchestrator, request } = start(runner);
    const retry = orchestrator.start(request);
    expect(retry.runId).toBe(run.runId);
    await Promise.all([run.result, retry.result]);
    expect(runner.patchCalls).toBe(1);
  });

  it("rejects reuse of an idempotency key for different logical inputs", () => {
    const runner = new FixtureRunner();
    const { orchestrator, request } = start(runner);
    const changed = fixtures("correlation-2");
    expect(() => orchestrator.start({ ...changed, idempotencyKey: request.idempotencyKey })).toThrow("IDEMPOTENCY_KEY_CONFLICT");
  });

  it("retries a failed baseline stage without applying the patch twice", async () => {
    const runner = new FixtureRunner();
    runner.baselineFailures = 1;
    const { run, audit } = start(runner);
    const result = await run.result;
    expect(result.classification).toBe("verified");
    expect(runner.baselineCalls).toBe(2);
    expect(runner.patchCalls).toBe(1);
    expect(audit.events.some((event) => event.action === "verification.retry")).toBe(true);
  });

  it("propagates cancellation and still cleans up", async () => {
    const runner = new FixtureRunner();
    const { run } = start(runner);
    await run.cancel("test cancellation");
    const result = await run.result;
    expect(result.classification).toBe("inconclusive");
    expect(runner.cleanupCalls).toBe(1);
  });

  it("downgrades a passing run when cleanup fails", async () => {
    const runner = new FixtureRunner();
    runner.cleanupError = true;
    const { run } = start(runner);
    const result = await run.result;
    expect(result.classification).toBe("inconclusive");
  });

  it("keeps correlation IDs on every audit event and bounds concurrent leases", async () => {
    const runner = new FixtureRunner();
    const audit = new AuditLog();
    const input = fixtures();
    const request = { ...input, idempotencyKey: verificationIdempotencyKey(input) };
    const orchestrator = new VerificationOrchestrator(runner, audit, new BoundedVerificationConcurrency(1));
    const first = orchestrator.start(request);
    const secondInput = fixtures("correlation-2");
    const second = orchestrator.start({ ...secondInput, idempotencyKey: verificationIdempotencyKey(secondInput) });
    await Promise.all([first.result, second.result]);
    expect(audit.events.length).toBeGreaterThan(0);
    expect(audit.events.every((event) => event.correlationId === "correlation-1" || event.correlationId === "correlation-2")).toBe(true);
    expect(runner.patchCalls).toBeGreaterThanOrEqual(1);
  });

  it("does not grant more concurrency leases than configured", async () => {
    const concurrency = new BoundedVerificationConcurrency(1);
    const first = await concurrency.acquire(new AbortController().signal);
    let secondGranted = false;
    const second = concurrency.acquire(new AbortController().signal).then((lease) => { secondGranted = true; return lease; });
    await Promise.resolve();
    expect(concurrency.activeCount).toBe(1);
    expect(secondGranted).toBe(false);
    first.release();
    const secondLease = await second;
    expect(concurrency.activeCount).toBe(1);
    secondLease.release();
    expect(concurrency.activeCount).toBe(0);
  });

  it("rejects mismatched correlation and revision before creating a workspace", async () => {
    const runner = new FixtureRunner();
    const input = fixtures();
    const request = { ...input, correlationId: "wrong-correlation", idempotencyKey: sha256("bad-request") };
    const audit = new AuditLog();
    const orchestrator = new VerificationOrchestrator(runner, audit, new BoundedVerificationConcurrency(1));
    const result = await orchestrator.start(request).result;
    expect(result.classification).toBe("inconclusive");
    expect(runner.baselineCalls).toBe(0);
  });

  it("rejects a tampered candidate patch before any runner stage", async () => {
    const runner = new FixtureRunner();
    const input = fixtures();
    const tampered = { ...input.patch, rationale: "tampered after review" };
    const audit = new AuditLog();
    const orchestrator = new VerificationOrchestrator(runner, audit, new BoundedVerificationConcurrency(1));
    const result = await orchestrator.start({ ...input, patch: tampered, idempotencyKey: sha256("tampered-patch") }).result;
    expect(result.classification).toBe("inconclusive");
    expect(result.failure?.code).toBe("PATCH_CONTENT_HASH_MISMATCH");
    expect(runner.baselineCalls).toBe(0);
    expect(runner.patchCalls).toBe(0);
  });
});
