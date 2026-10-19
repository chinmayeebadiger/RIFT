import { describe, expect, it } from "vitest";
import type { EvidenceItem } from "../domain/contracts.js";
import { InMemoryEvidenceStore } from "../domain/evidence-store.js";
import { withEvidenceHash } from "../domain/hashing.js";
import {
  RetentionAuthorizationError,
  RetentionManager,
  verifyRetentionPlan,
  verifyRetentionPurgeReceipt,
} from "./retention.js";

function evidence(id: string, createdAt: string): EvidenceItem {
  return withEvidenceHash({
    schemaVersion: 1,
    kind: "EvidenceItem",
    id,
    incidentId: "incident-1",
    correlationId: "run-1",
    createdAt,
    capturedAt: createdAt,
    content: { message: id },
    source: { type: "log", locator: `${id}.log` },
    redaction: { status: "not-required" },
    provenance: { actor: "test", tool: "fixture-loader" },
  });
}

function manager(store: InMemoryEvidenceStore): RetentionManager {
  return new RetentionManager(store, { policyId: "evidence-30d", retentionMs: 30 * 24 * 60 * 60 * 1000 });
}

describe("RetentionManager", () => {
  it("creates a dry-run plan with expired evidence and newer evidence protected", () => {
    const store = new InMemoryEvidenceStore([
      evidence("new", "2026-10-10T00:00:00.000Z"),
      evidence("old", "2026-08-01T00:00:00.000Z"),
    ]);
    const plan = manager(store).createDryRunPlan({ asOf: "2026-10-19T00:00:00.000Z" });

    expect(plan.dryRun).toBe(true);
    expect(plan.cutoff).toBe("2026-09-19T00:00:00.000Z");
    expect(plan.purgeEvidenceIds).toEqual(["old"]);
    expect(plan.protectedEvidenceIds).toEqual(["new"]);
    expect(verifyRetentionPlan(plan)).toBe(true);
  });

  it("does not authorize a purge without an explicit actor and authorization", () => {
    const store = new InMemoryEvidenceStore([evidence("old", "2026-08-01T00:00:00.000Z")]);
    const retention = manager(store);
    const plan = retention.plan({ asOf: "2026-10-19T00:00:00.000Z" });

    expect(() => retention.purge(plan, { authorized: false, actor: "operator" })).toThrow(RetentionAuthorizationError);
    expect(() => retention.purge(plan, { authorized: true, actor: "" })).toThrow(RetentionAuthorizationError);
    expect(retention.isPurged("old")).toBe(false);
  });

  it("orders plans deterministically independent of append order", () => {
    const first = new InMemoryEvidenceStore([
      evidence("z", "2026-08-02T00:00:00.000Z"),
      evidence("a", "2026-08-01T00:00:00.000Z"),
    ]);
    const second = new InMemoryEvidenceStore([
      evidence("a", "2026-08-01T00:00:00.000Z"),
      evidence("z", "2026-08-02T00:00:00.000Z"),
    ]);
    const options = { asOf: "2026-10-19T00:00:00.000Z" };

    expect(manager(first).plan(options)).toEqual(manager(second).plan(options));
  });

  it("returns a verifiable authorized receipt while preserving the append-only source", () => {
    const old = evidence("old", "2026-08-01T00:00:00.000Z");
    const newer = evidence("new", "2026-10-10T00:00:00.000Z");
    const store = new InMemoryEvidenceStore([old, newer]);
    const retention = manager(store);
    const plan = retention.plan({ asOf: "2026-10-19T00:00:00.000Z" });
    const receipt = retention.purge(plan, {
      authorized: true,
      actor: "human:retention-reviewer",
      reason: "scheduled retention review",
      executedAt: "2026-10-19T00:01:00.000Z",
    });

    expect(receipt.status).toBe("completed");
    expect(receipt.appendOnly).toBe(true);
    expect(receipt.purgedEvidenceIds).toEqual(["old"]);
    expect(receipt.protectedEvidenceIds).toEqual(["new"]);
    expect(verifyRetentionPurgeReceipt(receipt)).toBe(true);
    expect(store.list()).toEqual([old, newer]);
    expect(retention.listRetained()).toEqual([newer]);
  });

  it("protects evidence appended after a reviewed plan", () => {
    const store = new InMemoryEvidenceStore([evidence("old", "2026-08-01T00:00:00.000Z")]);
    const retention = manager(store);
    const plan = retention.plan({ asOf: "2026-10-19T00:00:00.000Z" });
    const newEvidence = evidence("new-after-plan", "2026-10-18T00:00:00.000Z");
    store.append(newEvidence);

    retention.purge(plan, { authorized: true, actor: "worker:retention" });

    expect(store.get(newEvidence.id)).toEqual(newEvidence);
    expect(retention.listRetained()).toEqual([newEvidence]);
  });
});
