import { describe, expect, it } from "vitest";
import type { EvidenceItem } from "./contracts.js";
import { assertModelSafeEvidence, EvidenceRedactionError, redactEvidenceForModel, redactSecrets } from "./redaction.js";
import { withEvidenceHash } from "./hashing.js";

function evidence(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  const item = {
    schemaVersion: 1 as const,
    kind: "EvidenceItem" as const,
    id: "evidence-redaction",
    incidentId: "incident-1",
    correlationId: "run-1",
    createdAt: "2026-10-18T10:00:00.000Z",
    capturedAt: "2026-10-18T10:00:01.000Z",
    content: { message: "safe failure" },
    source: { type: "log", locator: "fixture.log" },
    redaction: { status: "not-required" as const },
    provenance: { actor: "test", tool: "fixture-loader" },
    ...overrides,
  };
  return withEvidenceHash(item);
}

describe("evidence hashing", () => {
  it("hashes equivalent object values deterministically", async () => {
    const { hashContent } = await import("./hashing.js");
    expect(hashContent({ b: 2, a: 1 })).toBe(
      "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
    expect(hashContent({ a: 1, b: 2 })).toBe(hashContent({ b: 2, a: 1 }));
  });
});

describe("evidence redaction", () => {
  it("redacts secrets recursively before returning model evidence", () => {
    const original = evidence({
      content: {
        message: "request failed Authorization: Bearer abc.def.ghi",
        password: "do-not-share",
        nested: { apiKey: "sk-live-secret" },
      },
    });

    const safe = redactEvidenceForModel(original);
    expect(safe.content).toEqual({
      message: "request failed Authorization: Bearer [REDACTED]",
      password: "[REDACTED]",
      nested: { apiKey: "[REDACTED]" },
    });
    expect(safe.redaction.status).toBe("redacted");
    expect(safe.redaction.rules).toEqual(expect.arrayContaining(["bearer-token", "sensitive-field"]));
    expect(safe.contentHash).not.toBe(original.contentHash);
    expect(original.content).not.toEqual(safe.content);
    expect(() => assertModelSafeEvidence(safe)).not.toThrow();
  });

  it("fails closed while redaction is pending or cannot process a value", () => {
    expect(() => redactEvidenceForModel(evidence({ redaction: { status: "pending" } }))).toThrowError(
      EvidenceRedactionError,
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => redactSecrets(cyclic)).toThrowError(EvidenceRedactionError);
  });
});
