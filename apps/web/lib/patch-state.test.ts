import { describe, expect, it } from "vitest";
import type { CandidatePatch, Hypothesis } from "@rift/core";
import { getLeadingHypothesis, getPatchPanelState, hasVerificationResult } from "./patch-state";

const hypothesis = (status: "open" | "confirmed" | "rejected" = "open"): Hypothesis => ({
  kind: "Hypothesis" as const,
  schemaVersion: 1,
  id: "hypothesis-1",
  incidentId: "RIFT-042",
  correlationId: "run-1",
  createdAt: "2026-10-18T10:00:00.000Z",
  contentHash: "sha256:hypothesis",
  statement: "The retry path leaks a connection.",
  status,
  confidence: 0.9,
  supportingEvidenceIds: [],
  contradictingEvidenceIds: [],
  assumptions: [],
  nextCheck: "Inspect connection release.",
});

const patch = {
  kind: "CandidatePatch" as const,
  schemaVersion: 1,
  id: "patch-1",
  incidentId: "RIFT-042",
  correlationId: "run-1",
  createdAt: "2026-10-18T10:00:00.000Z",
  contentHash: "sha256:patch",
  sourceHypothesisId: "hypothesis-1",
  baseRevision: { repository: "rift", revision: "abcdef1" },
  diff: "- old\n+ new",
  touchedPaths: ["src/server.ts"],
  rationale: "Prevent the connection leak.",
  expectedInvariant: "Connections are released after retries.",
  generatedBy: { actor: "fake-model" as const },
} satisfies CandidatePatch;

describe("patch dashboard state", () => {
  it.each([
    ["loading", { loading: true, hypotheses: [], patches: [] }],
    ["error", { error: true, hypotheses: [], patches: [] }],
    ["empty", { hypotheses: [hypothesis()], patches: [] }],
    ["rejected", { hypotheses: [hypothesis("rejected")], patches: [] }],
    ["review-ready", { hypotheses: [hypothesis()], patches: [patch] }],
  ] as const)("returns the %s state", (expected, input) => {
    expect(getPatchPanelState(input)).toBe(expected);
  });

  it("uses API ranking order for the leading hypothesis", () => {
    const leading = hypothesis();
    expect(getLeadingHypothesis([leading, hypothesis("confirmed")])).toBe(leading);
  });

  it("never treats patch existence as verification", () => {
    expect(hasVerificationResult()).toBe(false);
    expect(hasVerificationResult(null)).toBe(false);
    expect(hasVerificationResult({} as never)).toBe(true);
  });
});
