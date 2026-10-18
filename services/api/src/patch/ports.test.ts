import { describe, expect, it } from "vitest";
import type {
  DiffValidationRequest,
  PatchGenerationRequest,
  PatchModelProposalRequest,
  PatchRankingRequest,
} from "./ports.js";

describe("Phase 3 patch boundary", () => {
  it("keeps patch work explicit, bounded, and separated from M2 orchestration", () => {
    const diffRequest = {
      incidentId: "RIFT-042",
      correlationId: "run-1",
      baseRevision: { repository: "rift-demo", revision: "abcdef1" },
      diff: "diff --git a/src/checkout.ts b/src/checkout.ts\n",
      declaredTouchedPaths: ["src/checkout.ts"],
      allowedPaths: ["src/checkout.ts"],
    } satisfies DiffValidationRequest;
    const modelRequest = {
      incidentId: "RIFT-042",
      correlationId: "run-1",
      sourceHypothesis: {} as PatchModelProposalRequest["sourceHypothesis"],
      snapshot: {} as PatchModelProposalRequest["snapshot"],
      redactedEvidence: [],
      inputHash: `sha256:${"a".repeat(64)}`,
      allowedPaths: ["src/checkout.ts"],
    } satisfies PatchModelProposalRequest;
    const rankingRequest = {
      incidentId: "RIFT-042",
      correlationId: "run-1",
      sourceHypothesis: {} as PatchRankingRequest["sourceHypothesis"],
      candidatePatches: [],
    } satisfies PatchRankingRequest;
    const generationRequest = {
      incidentId: "RIFT-042",
      correlationId: "run-1",
      manifest: {} as PatchGenerationRequest["manifest"],
      snapshot: {} as PatchGenerationRequest["snapshot"],
      hypothesisSet: {} as PatchGenerationRequest["hypothesisSet"],
      sourceHypothesis: {} as PatchGenerationRequest["sourceHypothesis"],
      evidence: [],
      redactedEvidence: [],
    } satisfies PatchGenerationRequest;

    expect(diffRequest.allowedPaths).toEqual(["src/checkout.ts"]);
    expect(modelRequest.inputHash).toMatch(/^sha256:/u);
    expect(rankingRequest.candidatePatches).toHaveLength(0);
    expect(generationRequest.redactedEvidence).toEqual([]);
  });
});
