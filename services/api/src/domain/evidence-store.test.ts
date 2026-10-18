import { describe, expect, it } from "vitest";
import type { EvidenceItem } from "./contracts.js";
import { InMemoryEvidenceStore } from "./evidence-store.js";

function evidence(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    schemaVersion: 1,
    kind: "EvidenceItem",
    id: "evidence-1",
    incidentId: "incident-1",
    correlationId: "run-1",
    createdAt: "2026-10-18T10:00:00.000Z",
    capturedAt: "2026-10-18T10:00:01.000Z",
    contentHash: "sha256:abc123",
    content: { message: "synthetic failure" },
    source: { type: "log", locator: "fixture.log" },
    redaction: { status: "not-required" },
    provenance: { actor: "test", tool: "fixture-loader" },
    ...overrides,
  };
}

describe("InMemoryEvidenceStore", () => {
  it("preserves append order and supports incident/source queries", () => {
    const store = new InMemoryEvidenceStore();
    store.append(evidence());
    store.append(
      evidence({
        id: "evidence-2",
        incidentId: "incident-2",
        source: { type: "stack-trace", locator: "trace.txt" },
      }),
    );

    expect(store.list().map((item) => item.id)).toEqual(["evidence-1", "evidence-2"]);
    expect(store.list({ incidentId: "incident-2" }).map((item) => item.id)).toEqual(["evidence-2"]);
    expect(store.list({ sourceType: "log" }).map((item) => item.id)).toEqual(["evidence-1"]);
  });

  it("rejects duplicate ids and protects stored items from caller mutation", () => {
    const store = new InMemoryEvidenceStore();
    const item = evidence();
    store.append(item);

    const returned = store.get(item.id);
    expect(returned).toBeDefined();
    if (returned !== undefined && typeof returned.content === "object" && returned.content !== null) {
      (returned.content as { message: string }).message = "mutated outside the store";
    }

    expect(store.get(item.id)?.content).toEqual({ message: "synthetic failure" });
    expect(() => store.append(item)).toThrow(`Evidence item already exists: ${item.id}`);
  });
});
