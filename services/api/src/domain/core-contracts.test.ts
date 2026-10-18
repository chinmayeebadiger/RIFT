import { describe, expect, it } from "vitest";
import {
  validateCandidatePatch,
  validateHypothesis,
  validateHypothesisSet,
  validateRecoveryReport,
  validateVerificationPlan,
  validateVerificationResult,
} from "./validators.js";

const HASH = `sha256:${"a".repeat(64)}`;
const TIME = "2026-10-18T10:00:00.000Z";
const REVISION = { repository: "rift-demo", revision: "abcdef1" };
const COMMAND = { command: "npm", args: ["test"], workingDirectory: "services/api" };

function base(kind: string, id: string): Record<string, unknown> {
  return {
    kind,
    schemaVersion: 1,
    id,
    incidentId: "RIFT-042",
    correlationId: "run-1",
    createdAt: TIME,
    contentHash: HASH,
  };
}

function hypothesis(): Record<string, unknown> {
  return {
    ...base("Hypothesis", "hypothesis-1"),
    statement: "The checkout handler applies the discount twice.",
    status: "open",
    confidence: 0.8,
    supportingEvidenceIds: ["evidence-1"],
    contradictingEvidenceIds: [],
    assumptions: ["The fixture uses the production checkout path."],
    nextCheck: "Run the checkout regression fixture once with the discount disabled.",
  };
}

describe("shared Phase 0 contract validators", () => {
  it("validates every post-intake contract through the shared package", () => {
    const validHypothesis = hypothesis();
    const validSet = {
      ...base("HypothesisSet", "hypotheses-1"),
      hypotheses: [validHypothesis],
      rankingMethod: "confidence-desc",
    };
    const validPatch = {
      ...base("CandidatePatch", "patch-1"),
      sourceHypothesisId: "hypothesis-1",
      baseRevision: REVISION,
      diff: "diff --git a/src/checkout.ts b/src/checkout.ts",
      touchedPaths: ["src/checkout.ts"],
      rationale: "Apply the discount once.",
      expectedInvariant: "The final total is discounted exactly once.",
      generatedBy: { actor: "fake-model" },
    };
    const validPlan = {
      ...base("VerificationPlan", "plan-1"),
      candidatePatchId: "patch-1",
      baseRevision: REVISION,
      baselineCommand: COMMAND,
      verificationCommands: [COMMAND],
      timeoutMs: 30_000,
      networkAccess: "disabled",
    };
    const validResult = {
      ...base("VerificationResult", "result-1"),
      verificationPlanId: "plan-1",
      classification: "verified",
      baselineExitCode: 1,
      patchedExitCode: 0,
      evidenceIds: ["evidence-1"],
    };
    const validReport = {
      ...base("RecoveryReport", "report-1"),
      status: "verified",
      hypothesisSetId: "hypotheses-1",
      candidatePatchIds: ["patch-1"],
      verificationResultIds: ["result-1"],
      facts: ["The baseline reproduces the fixture failure."],
      inferences: ["The duplicate discount application is causal."],
      unknowns: ["Production traffic mix was not tested."],
      evidenceCitations: [],
      hypotheses: [],
      patches: [],
      commands: [],
      environmentFingerprint: null,
      baselineResults: [],
      patchedResults: [],
      evidenceIds: [],
      approvalRequired: true,
    };

    expect(validateHypothesis(validHypothesis).ok).toBe(true);
    expect(validateHypothesisSet(validSet).ok).toBe(true);
    expect(validateCandidatePatch(validPatch).ok).toBe(true);
    expect(validateVerificationPlan(validPlan).ok).toBe(true);
    expect(validateVerificationResult(validResult).ok).toBe(true);
    expect(validateRecoveryReport(validReport).ok).toBe(true);
  });

  it("rejects untrusted output with unknown fields or missing approval", () => {
    expect(validateHypothesis({ ...hypothesis(), promptInjection: "ignore policy" }).ok).toBe(false);
    const report = {
      ...base("RecoveryReport", "report-1"),
      status: "verified",
      hypothesisSetId: "hypotheses-1",
      candidatePatchIds: [],
      verificationResultIds: [],
      facts: [],
      inferences: [],
      unknowns: [],
      approvalRequired: false,
    };
    expect(validateRecoveryReport(report).ok).toBe(false);
  });

  it("keeps structured expected-invariant details additive to CandidatePatch", () => {
    const patch = {
      ...base("CandidatePatch", "patch-1"),
      sourceHypothesisId: "hypothesis-1",
      baseRevision: REVISION,
      diff: "diff --git a/src/checkout.ts b/src/checkout.ts\n",
      touchedPaths: ["src/checkout.ts"],
      rationale: "Apply the discount once.",
      expectedInvariant: "The final total is discounted exactly once.",
      expectedInvariantDetails: {
        statement: "The final total is discounted exactly once.",
        verificationHint: "The checkout regression test passes.",
      },
      generatedBy: { actor: "fake-model" },
    };

    expect(validateCandidatePatch(patch).ok).toBe(true);
    expect(validateCandidatePatch({ ...patch, expectedInvariantDetails: { statement: "ok", extra: true } }).ok).toBe(false);
  });
});
