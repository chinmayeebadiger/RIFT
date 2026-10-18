import { describe, expect, it } from "vitest";
import type {
  CandidatePatch,
  EvidenceItem,
  Hypothesis,
  JsonValue,
  RepositoryRevision,
} from "@rift/core";
import {
  DEFAULT_PATCH_RANKING_WEIGHTS,
  computeCandidatePatchContentHash,
  rankCandidatePatches,
  type CandidatePatchRankingInput,
} from "./candidate-patch-ranker.js";

const TIME = "2026-10-18T10:00:00.000Z";
const REVISION: RepositoryRevision = { repository: "rift-demo", revision: "abcdef1" };
const HASH = `sha256:${"a".repeat(64)}`;

function base(kind: string, id: string): Record<string, unknown> {
  return {
    kind,
    schemaVersion: 1,
    id,
    incidentId: "RIFT-042",
    correlationId: "patch-run-1",
    createdAt: TIME,
    contentHash: HASH,
  };
}

function hypothesis(id: string, overrides: Partial<Hypothesis> = {}): Hypothesis {
  return {
    ...base("Hypothesis", id),
    statement: "The checkout handler applies the discount twice.",
    status: "open",
    confidence: 0.8,
    supportingEvidenceIds: ["evidence-checkout"],
    contradictingEvidenceIds: [],
    assumptions: ["The fixture uses the production checkout path."],
    nextCheck: "Run the checkout regression fixture once with the discount disabled.",
    ...overrides,
  } as Hypothesis;
}

function evidence(id: string): EvidenceItem {
  return {
    ...base("EvidenceItem", id),
    content: { message: "checkout total reproduced the incident" },
    source: { type: "test-log", locator: "tests/checkout.log" },
    capturedAt: TIME,
    redaction: { status: "not-required" },
    provenance: { actor: "test" },
  } as unknown as EvidenceItem;
}

function patch(id: string, overrides: Partial<CandidatePatch> = {}): CandidatePatch {
  const { contentHash: _baseHash, ...withoutHash } = {
    ...base("CandidatePatch", id),
    sourceHypothesisId: "hypothesis-supported",
    baseRevision: REVISION,
    diff: `diff --git a/src/checkout.ts b/src/checkout.ts ${id}`,
    touchedPaths: ["src/checkout.ts"],
    rationale: "Apply the discount exactly once at the checkout boundary.",
    expectedInvariant: "The final total contains at most one discount application.",
    generatedBy: { actor: "fake-model" },
    ...overrides,
  } as Record<string, unknown>;
  return { ...withoutHash, contentHash: computeCandidatePatchContentHash(withoutHash as unknown as Omit<CandidatePatch, "contentHash">) } as CandidatePatch;
}

function input(overrides: Partial<CandidatePatchRankingInput> = {}): CandidatePatchRankingInput {
  return {
    candidates: [patch("patch-a")],
    hypotheses: [hypothesis("hypothesis-supported")],
    evidence: [evidence("evidence-checkout")],
    allowedPaths: ["src"],
    repositoryRevision: REVISION,
    ...overrides,
  };
}

describe("Phase 3 candidate-patch ranking", () => {
  it.each([
    ["evidence support", "evidenceSupport"],
    ["hypothesis confidence", "hypothesisConfidence"],
    ["expected invariant", "expectedInvariant"],
    ["touched-path scope", "touchedPathScope"],
    ["reproduction relevance", "reproductionRelevance"],
  ] as const)("ranks the candidate with stronger %s first", (_label, dimension) => {
    const strongerHypothesis = hypothesis("hypothesis-strong", {
      confidence: dimension === "hypothesisConfidence" ? 1 : 0.8,
      supportingEvidenceIds: dimension === "evidenceSupport"
        ? ["evidence-checkout"]
        : ["evidence-checkout", "evidence-extra"],
    });
    const weakerHypothesis = hypothesis("hypothesis-weak", {
      confidence: dimension === "hypothesisConfidence" ? 0.1 : 0.8,
      supportingEvidenceIds: dimension === "evidenceSupport"
        ? ["evidence-checkout"]
        : ["evidence-checkout"],
    });
    const stronger = patch("patch-strong", {
      sourceHypothesisId: strongerHypothesis.id,
      expectedInvariant: dimension === "expectedInvariant" ? "A".repeat(160) : "The final total contains at most one discount application.",
      touchedPaths: dimension === "touchedPathScope" ? ["src/checkout.ts"] : ["src/checkout.ts", "src/cart.ts"],
    });
    const weaker = patch("patch-weak", {
      sourceHypothesisId: weakerHypothesis.id,
      expectedInvariant: dimension === "expectedInvariant" ? "A" : "The final total contains at most one discount application.",
      touchedPaths: dimension === "touchedPathScope" ? ["src/checkout.ts", "src/cart.ts"] : ["src/checkout.ts"],
    });
    const candidates = dimension === "reproductionRelevance"
      ? [patch("patch-strong", { sourceHypothesisId: strongerHypothesis.id, touchedPaths: ["src/checkout.ts"] }), patch("patch-weak", { sourceHypothesisId: weakerHypothesis.id, touchedPaths: ["src/cart.ts"] })]
      : [weaker, stronger];

    const scores = { ...DEFAULT_PATCH_RANKING_WEIGHTS, [dimension]: 1 };
    const result = rankCandidatePatches(input({
      candidates,
      hypotheses: [strongerHypothesis, weakerHypothesis],
      evidence: [evidence("evidence-checkout"), evidence("evidence-extra")],
      hypothesisEvidence: dimension === "evidenceSupport" ? [{
        hypothesisId: strongerHypothesis.id,
        citations: [{ evidenceId: "evidence-checkout", evidenceHash: HASH, relation: "supports", locator: "tests/checkout.log:1" }],
      }] : [],
      reproductionRelevantPaths: ["src/checkout.ts"],
      weights: scores,
    }));

    expect(result.accepted.map(({ patch: rankedPatch }) => rankedPatch.id)).toEqual(["patch-strong", "patch-weak"]);
  });

  it("uses a deterministic content-hash tie breaker independent of input order", () => {
    const first = patch("patch-a");
    const second = patch("patch-b");
    const forward = rankCandidatePatches(input({ candidates: [second, first] }));
    const reversed = rankCandidatePatches(input({ candidates: [first, second] }));
    const expected = [first, second].sort((left, right) => left.contentHash.localeCompare(right.contentHash)).map(({ id }) => id);

    expect(forward).toEqual(reversed);
    expect(forward.accepted.map(({ patch: rankedPatch }) => rankedPatch.id)).toEqual(expected);
  });

  it.each([
    ["unsupported", "unsupported", hypothesis("hypothesis-unsupported", { supportingEvidenceIds: [] })],
    ["contradictory", "contradictory", hypothesis("hypothesis-contradicted", { contradictingEvidenceIds: ["evidence-bad"] })],
    ["out-of-scope", "out-of-scope", hypothesis("hypothesis-out-of-scope")],
  ] as const)("rejects %s candidates with a structured reason", (_label, reason, candidateHypothesis) => {
    const candidate = patch(`patch-${reason}`, {
      sourceHypothesisId: candidateHypothesis.id,
      ...(reason === "out-of-scope" ? { touchedPaths: ["docs/README.md"] } : {}),
    });
    const result = rankCandidatePatches(input({ candidates: [candidate], hypotheses: [candidateHypothesis] }));

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toContainEqual(expect.objectContaining({ candidatePatchId: candidate.id, reason }));
  });

  it("rejects a support citation that does not resolve to supplied evidence", () => {
    const candidateHypothesis = hypothesis("hypothesis-missing-citation", {
      supportingEvidenceIds: ["evidence-missing"],
    });
    const candidate = patch("patch-missing-citation", {
      sourceHypothesisId: candidateHypothesis.id,
    });

    const result = rankCandidatePatches(input({
      candidates: [candidate],
      hypotheses: [candidateHypothesis],
      evidence: [evidence("evidence-checkout")],
      hypothesisEvidence: [{
        hypothesisId: candidateHypothesis.id,
        citations: [{
          evidenceId: "evidence-missing",
          evidenceHash: HASH,
          relation: "supports",
          locator: "missing.log:1",
        }],
      }],
    }));

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toContainEqual(expect.objectContaining({
      candidatePatchId: candidate.id,
      reason: "unsupported",
    }));
  });

  it("ignores an unresolved contradiction citation when evidence context is supplied", () => {
    const candidateHypothesis = hypothesis("hypothesis-unresolved-contradiction");
    const candidate = patch("patch-unresolved-contradiction", {
      sourceHypothesisId: candidateHypothesis.id,
    });

    const result = rankCandidatePatches(input({
      candidates: [candidate],
      hypotheses: [candidateHypothesis],
      evidence: [evidence("evidence-checkout")],
      hypothesisEvidence: [{
        hypothesisId: candidateHypothesis.id,
        citations: [{
          evidenceId: "evidence-missing",
          evidenceHash: HASH,
          relation: "contradicts",
          locator: "missing.log:1",
        }],
      }],
    }));

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toEqual([]);
  });

  it("preserves accepted patch metadata and verifies its canonical content hash", () => {
    const accepted = patch("patch-accepted", {
      rationale: "Move discount calculation behind the single checkout guard.",
      touchedPaths: ["src/checkout.ts"],
      expectedInvariant: "A checkout total applies the discount no more than once.",
    });
    const result = rankCandidatePatches(input({ candidates: [accepted] }));
    const returned = result.accepted[0]?.patch;

    expect(returned).toMatchObject({
      id: accepted.id,
      rationale: accepted.rationale,
      touchedPaths: accepted.touchedPaths,
      expectedInvariant: accepted.expectedInvariant,
      contentHash: accepted.contentHash,
    });
    const { contentHash: _contentHash, ...withoutHash } = accepted;
    expect(returned?.contentHash).toBe(computeCandidatePatchContentHash(withoutHash));
  });

  it("replays the same request deterministically", () => {
    const request = input({ candidates: [patch("patch-z"), patch("patch-a")] });
    const first = rankCandidatePatches(request);
    const replay = rankCandidatePatches(JSON.parse(JSON.stringify(request)) as CandidatePatchRankingInput);

    expect(replay).toEqual(first);
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
  });
});
