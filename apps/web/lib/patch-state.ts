import type { CandidatePatch, Hypothesis, VerificationResult } from "@rift/core";

export type PatchPanelState = "loading" | "empty" | "error" | "rejected" | "review-ready";

export interface PatchStateInput {
  loading?: boolean;
  error?: boolean;
  hypotheses: readonly Hypothesis[];
  patches: readonly CandidatePatch[];
}

export function getLeadingHypothesis(hypotheses: readonly Hypothesis[]): Hypothesis | undefined {
  return hypotheses[0];
}

export function getPatchPanelState({ loading = false, error = false, hypotheses, patches }: PatchStateInput): PatchPanelState {
  if (loading) return "loading";
  if (error) return "error";
  if (patches.some((patch) => "status" in patch && patch.status === "rejected") || getLeadingHypothesis(hypotheses)?.status === "rejected") {
    return "rejected";
  }
  return patches.length > 0 ? "review-ready" : "empty";
}

export function hasVerificationResult(result?: VerificationResult | null): boolean {
  return result !== undefined && result !== null;
}
