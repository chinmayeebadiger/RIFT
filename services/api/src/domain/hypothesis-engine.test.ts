import { describe, expect, it } from "vitest";
import type { EvidenceItem, JsonValue } from "./contracts.js";
import { withEvidenceHash } from "./hashing.js";
import {
  generateHypothesisSet,
  runHypothesisEngine,
  type HypothesisEngineInput,
} from "./hypothesis-engine.js";
import { validateHypothesisSet } from "./validators.js";

const TIME = "2026-10-18T10:00:00.000Z";

function evidence(id: string, content: string | Record<string, JsonValue>): EvidenceItem {
  return withEvidenceHash({
    schemaVersion: 1,
    kind: "EvidenceItem",
    id,
    incidentId: "RIFT-M2",
    correlationId: "m2-run",
    createdAt: TIME,
    capturedAt: TIME,
    content,
    source: { type: "application-log", locator: `logs/${id}.log` },
    redaction: { status: "not-required" },
    provenance: { actor: "test", tool: "fixture" },
  });
}

function input(items: readonly EvidenceItem[]): HypothesisEngineInput {
  return {
    incidentId: "RIFT-M2",
    correlationId: "m2-run",
    createdAt: TIME,
    evidence: items,
  };
}

describe("offline hypothesis engine", () => {
  it("normalizes the M1-style failure signature and uses its source citation", () => {
    const result = runHypothesisEngine(input([
      evidence("checkout-log", 'route=/checkout status=503 signature=CHECKOUT_RETRY_POOL_EXHAUSTED message="checkout retry budget exhausted"'),
    ]));

    expect(result.failureSignatures).toEqual([
      expect.objectContaining({
        name: "CHECKOUT_RETRY_POOL_EXHAUSTED",
        status: 503,
        message: "checkout retry budget exhausted",
        evidenceIds: ["checkout-log"],
      }),
    ]);
    expect(result.hypothesisSet.hypotheses[0]).toMatchObject({
      statement: "Checkout retry handling exhausts the configured retry budget.",
      supportingEvidenceIds: ["checkout-log"],
    });
  });

  it("ranks a directly supported known cause above a weaker independent cause", () => {
    const result = runHypothesisEngine(input([
      evidence("discount-log", 'signature=checkout-total-mismatch status=500 message="discount applied twice"'),
      evidence("search-log", "search mismatch: hoodie is not returned for the lowercase query"),
    ]));

    expect(result.hypothesisSet.hypotheses[0]?.statement).toBe("The checkout discount is applied more than once.");
    expect(result.hypothesisSet.hypotheses[0]?.confidence).toBeGreaterThan(result.hypothesisSet.hypotheses[1]?.confidence ?? 0);
    expect(validateHypothesisSet(result.hypothesisSet)).toEqual({ ok: true, value: result.hypothesisSet });
  });

  it("cites only immutable evidence ids and keeps facts separate from inferences", () => {
    const result = runHypothesisEngine(input([
      evidence("discount-log", 'signature=checkout-total-mismatch status=500 message="discount applied twice"'),
    ]));
    const hypothesis = result.hypothesisSet.hypotheses[0];

    expect(hypothesis?.supportingEvidenceIds).toEqual(["discount-log"]);
    expect(hypothesis?.contradictingEvidenceIds).toEqual([]);
    expect(result.facts).toEqual([{ evidenceId: "discount-log", statement: expect.stringContaining("discount applied twice") }]);
    expect(result.inferences[0]).toMatchObject({
      hypothesisId: hypothesis?.id,
      statement: hypothesis?.statement,
      supportingEvidenceIds: ["discount-log"],
    });
    expect(result.facts[0]?.statement).not.toBe(hypothesis?.statement);
  });

  it("marks a weak observation inconclusive and records the discriminating check", () => {
    const result = runHypothesisEngine(input([
      evidence("weak-log", "discount applied twice observed in one request"),
    ]));
    const hypothesis = result.hypothesisSet.hypotheses[0];

    expect(hypothesis?.status).toBe("inconclusive");
    expect(hypothesis?.confidence).toBeLessThan(0.75);
    expect(hypothesis?.assumptions.length).toBeGreaterThan(0);
    expect(hypothesis?.nextCheck).toContain("count the discount operations");
  });

  it("retains contradictory citations and lowers confidence instead of hiding them", () => {
    const result = runHypothesisEngine(input([
      evidence("supporting-log", "discount applied twice for checkout request"),
      evidence("contradicting-log", "control path confirms discount applied once"),
    ]));
    const hypothesis = result.hypothesisSet.hypotheses.find((candidate) => candidate.statement === "The checkout discount is applied more than once.");

    expect(hypothesis).toBeDefined();
    expect(hypothesis?.supportingEvidenceIds).toEqual(["supporting-log"]);
    expect(hypothesis?.contradictingEvidenceIds).toEqual(["contradicting-log"]);
    expect(hypothesis?.status).toBe("inconclusive");
    expect(hypothesis?.assumptions).toContain("Contradicting evidence must be reconciled by the next check.");
  });

  it("replays byte-for-byte for identical input regardless of evidence order", () => {
    const items = [
      evidence("b-log", "search mismatch: hoodie is not returned for the lowercase query"),
      evidence("a-log", 'signature=checkout-total-mismatch status=500 message="discount applied twice"'),
    ];

    const first = generateHypothesisSet(input(items));
    const second = generateHypothesisSet(input([...items].reverse()));

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.contentHash).toBe(second.contentHash);
  });
});
