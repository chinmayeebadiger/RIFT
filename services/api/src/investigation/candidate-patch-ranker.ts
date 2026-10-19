import type {
  CandidatePatch,
  CommandSpec,
  EvidenceItem,
  Hypothesis,
  HypothesisEvidence,
  IncidentManifest,
  JsonValue,
  RepositoryRevision,
  Sha256Hash,
  ValidationIssue,
} from "@rift/core";
import { validateCandidatePatch } from "@rift/core";
import { canonicalJson, sha256 } from "../domain/hashing.js";

/** A candidate may arrive from an untrusted model without its derived hash. */
export type CandidatePatchDraft = Omit<CandidatePatch, "contentHash"> & {
  readonly contentHash?: Sha256Hash;
};

export interface PatchRankingWeights {
  readonly evidenceSupport: number;
  readonly hypothesisConfidence: number;
  readonly expectedInvariant: number;
  readonly touchedPathScope: number;
  readonly reproductionRelevance: number;
}

export const DEFAULT_PATCH_RANKING_WEIGHTS: PatchRankingWeights = Object.freeze({
  evidenceSupport: 0.3,
  hypothesisConfidence: 0.25,
  expectedInvariant: 0.2,
  touchedPathScope: 0.15,
  reproductionRelevance: 0.1,
});

export interface CandidatePatchRankingInput {
  readonly candidates: readonly unknown[];
  readonly hypotheses: readonly Hypothesis[];
  readonly evidence?: readonly EvidenceItem[];
  readonly hypothesisEvidence?: readonly HypothesisEvidence[];
  readonly allowedPaths: readonly string[];
  readonly reproductionRelevantPaths?: readonly string[];
  readonly reproductionCommand?: CommandSpec;
  readonly repositoryRevision?: RepositoryRevision;
  readonly weights?: Partial<PatchRankingWeights>;
}

export interface PatchScore {
  readonly evidenceSupport: number;
  readonly hypothesisConfidence: number;
  readonly expectedInvariant: number;
  readonly touchedPathScope: number;
  readonly reproductionRelevance: number;
  readonly total: number;
}

export interface RankedCandidatePatch {
  readonly patch: CandidatePatch;
  readonly scores: PatchScore;
  readonly rank: number;
}

export type PatchRejectionReason =
  | "invalid-patch"
  | "missing-hypothesis"
  | "unsupported"
  | "contradictory"
  | "out-of-scope"
  | "base-revision-mismatch";

export interface RejectedCandidatePatch {
  readonly candidate: unknown;
  readonly candidatePatchId?: string;
  readonly reason: PatchRejectionReason;
  readonly issues: readonly ValidationIssue[];
}

export interface CandidatePatchRankingResult {
  readonly accepted: readonly RankedCandidatePatch[];
  readonly rejected: readonly RejectedCandidatePatch[];
}

type PatchWithoutHash = Omit<CandidatePatch, "contentHash">;

/**
 * Hashes the normalized CandidatePatch payload, excluding contentHash itself.
 * Object keys are sorted by canonicalJson, so construction order cannot alter
 * the identity of an otherwise equivalent patch.
 */
export function computeCandidatePatchContentHash(patch: PatchWithoutHash): Sha256Hash {
  const { contentHash: _contentHash, ...withoutHash } = patch as PatchWithoutHash & { readonly contentHash?: unknown };
  return sha256(withoutHash as unknown as JsonValue);
}

export const calculateCandidatePatchContentHash = computeCandidatePatchContentHash;

export function withCandidatePatchContentHash(patch: PatchWithoutHash): CandidatePatch {
  return { ...patch, contentHash: computeCandidatePatchContentHash(patch) };
}

/** Exposed for callers that need to compare a patch payload before persistence. */
export function canonicalCandidatePatchPayload(patch: PatchWithoutHash): string {
  return canonicalJson(patch as unknown as JsonValue);
}

function issue(path: string, code: string): ValidationIssue {
  return { path, code };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableUnknownKey(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") return `string:${JSON.stringify(value)}`;
  if (typeof value === "number") return `number:${Number.isFinite(value) ? value : String(value)}`;
  if (typeof value === "boolean") return `boolean:${value}`;
  if (typeof value === "undefined") return "undefined";
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (typeof value === "symbol") return `symbol:${String(value)}`;
  if (typeof value === "function") return `function:${String(value)}`;
  if (ancestors.has(value)) return "[circular]";

  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableUnknownKey(item, nextAncestors)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableUnknownKey(object[key], nextAncestors)}`).join(",")}}`;
}

function pathIsWithin(path: string, scope: string): boolean {
  return path === scope || path.startsWith(`${scope}/`);
}

function pathInAnyScope(path: string, scopes: readonly string[]): boolean {
  return scopes.some((scope) => pathIsWithin(path, scope));
}

function validRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..") && !path.split("/").includes("");
}

function mergeWeights(weights?: Partial<PatchRankingWeights>): PatchRankingWeights {
  const merged = {
    ...DEFAULT_PATCH_RANKING_WEIGHTS,
    ...weights,
  };
  const total = Object.values(merged).reduce((sum, value) => sum + value, 0);
  if (!Object.values(merged).every((value) => Number.isFinite(value) && value >= 0) || total <= 0) {
    throw new Error("Patch ranking weights must be finite non-negative numbers with a positive total");
  }
  return {
    evidenceSupport: merged.evidenceSupport / total,
    hypothesisConfidence: merged.hypothesisConfidence / total,
    expectedInvariant: merged.expectedInvariant / total,
    touchedPathScope: merged.touchedPathScope / total,
    reproductionRelevance: merged.reproductionRelevance / total,
  };
}

function hypothesisById(hypotheses: readonly Hypothesis[]): ReadonlyMap<string, Hypothesis> {
  return new Map(hypotheses.map((hypothesis) => [hypothesis.id, hypothesis]));
}

function evidenceById(evidence: readonly EvidenceItem[] | undefined): ReadonlyMap<string, EvidenceItem> {
  return new Map((evidence ?? []).map((item) => [item.id, item]));
}

function hypothesisEvidenceById(items: readonly HypothesisEvidence[] | undefined): ReadonlyMap<string, HypothesisEvidence> {
  return new Map((items ?? []).map((item) => [item.hypothesisId, item]));
}

function normalizePatch(candidate: unknown): { readonly patch?: CandidatePatch; readonly issues: readonly ValidationIssue[] } {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return { issues: [issue("$", "invalid_type")] };
  }

  const record = candidate as Record<string, unknown>;
  const withoutHash = { ...record };
  delete withoutHash.contentHash;
  let computedHash: Sha256Hash;
  try {
    computedHash = computeCandidatePatchContentHash(withoutHash as PatchWithoutHash);
  } catch {
    return { issues: [issue("$", "invalid_json_value")] };
  }
  const normalized = { ...withoutHash, contentHash: computedHash };
  const validation = validateCandidatePatch(normalized);
  if (!validation.ok) return { issues: validation.issues };

  if (record.contentHash !== undefined && record.contentHash !== computedHash) {
    return { issues: [issue("$.contentHash", "hash_mismatch")] };
  }
  return { patch: validation.value, issues: [] };
}

function expectedInvariantScore(invariant: string): number {
  // A present, bounded invariant is required. Longer invariant text is only a
  // deterministic proxy for specificity; it is capped so verbosity cannot
  // dominate evidence or confidence.
  return Math.min(1, invariant.trim().length / 160);
}

function evidenceSupportScore(
  hypothesis: Hypothesis,
  evidence: ReadonlyMap<string, EvidenceItem>,
  hasEvidenceContext: boolean,
  citations: HypothesisEvidence | undefined,
): number {
  const supportingIds = new Set(hypothesis.supportingEvidenceIds);
  const knownSupporting = [...supportingIds].filter((id) => !hasEvidenceContext || evidence.has(id)).length;
  const citedSupporting = (citations?.citations ?? []).filter(
    (citation) => citation.relation === "supports"
      && supportingIds.has(citation.evidenceId)
      && (!hasEvidenceContext || evidence.has(citation.evidenceId)),
  ).length;
  return Math.min(1, (knownSupporting + citedSupporting) / Math.max(1, supportingIds.size * 2));
}

function reproductionPaths(input: CandidatePatchRankingInput): readonly string[] {
  if (input.reproductionRelevantPaths && input.reproductionRelevantPaths.length > 0) {
    return input.reproductionRelevantPaths;
  }
  const workingDirectory = input.reproductionCommand?.workingDirectory;
  return workingDirectory ? [workingDirectory] : [];
}

function scorePatch(
  patch: CandidatePatch,
  hypothesis: Hypothesis,
  input: CandidatePatchRankingInput,
  evidence: ReadonlyMap<string, EvidenceItem>,
  hasEvidenceContext: boolean,
  citations: HypothesisEvidence | undefined,
  weights: PatchRankingWeights,
): PatchScore {
  const relevantPaths = reproductionPaths(input);
  const relevantCount = relevantPaths.length === 0
    ? 0
    : patch.touchedPaths.filter((path) => pathInAnyScope(path, relevantPaths)).length;
  const reproductionRelevance = relevantPaths.length === 0
    ? 0
    : relevantCount / patch.touchedPaths.length;
  const touchedPathScope = 1 / patch.touchedPaths.length;
  const dimensions = {
    evidenceSupport: evidenceSupportScore(hypothesis, evidence, hasEvidenceContext, citations),
    hypothesisConfidence: hypothesis.confidence,
    expectedInvariant: expectedInvariantScore(patch.expectedInvariant),
    touchedPathScope,
    reproductionRelevance,
  };
  const total = Object.entries(dimensions).reduce(
    (sum, [key, value]) => sum + value * weights[key as keyof PatchRankingWeights],
    0,
  );
  return { ...dimensions, total };
}

function rejection(
  candidate: unknown,
  reason: PatchRejectionReason,
  issues: readonly ValidationIssue[] = [],
): RejectedCandidatePatch {
  const candidatePatchId = typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
    && typeof (candidate as { readonly id?: unknown }).id === "string"
    ? (candidate as { readonly id: string }).id
    : undefined;
  return { candidate, candidatePatchId, reason, issues };
}

function compareRankedPatches(left: RankedCandidatePatch, right: RankedCandidatePatch): number {
  if (left.scores.total !== right.scores.total) return right.scores.total - left.scores.total;
  const dimensions: readonly (keyof Omit<PatchScore, "total">)[] = [
    "evidenceSupport",
    "hypothesisConfidence",
    "expectedInvariant",
    "touchedPathScope",
    "reproductionRelevance",
  ];
  for (const dimension of dimensions) {
    if (left.scores[dimension] !== right.scores[dimension]) return right.scores[dimension] - left.scores[dimension];
  }
  return compareStrings(left.patch.contentHash, right.patch.contentHash);
}

function isBaseRevisionMismatch(patch: CandidatePatch, revision: RepositoryRevision | undefined): boolean {
  return revision !== undefined
    && (patch.baseRevision.repository !== revision.repository || patch.baseRevision.revision !== revision.revision);
}

/**
 * Validates, rejects, scores, and deterministically orders candidate patches.
 * This function is pure: it does not apply patches, read files, or invoke tools.
 */
export function rankCandidatePatches(input: CandidatePatchRankingInput): CandidatePatchRankingResult {
  const weights = mergeWeights(input.weights);
  const hypotheses = hypothesisById(input.hypotheses);
  const evidence = evidenceById(input.evidence);
  const hasEvidenceContext = input.evidence !== undefined;
  const hypothesisEvidence = hypothesisEvidenceById(input.hypothesisEvidence);
  const accepted: RankedCandidatePatch[] = [];
  const rejected: RejectedCandidatePatch[] = [];

  for (const candidate of input.candidates) {
    const normalized = normalizePatch(candidate);
    if (!normalized.patch) {
      rejected.push(rejection(candidate, "invalid-patch", normalized.issues));
      continue;
    }
    const patch = normalized.patch;
    const hypothesis = hypotheses.get(patch.sourceHypothesisId);
    if (!hypothesis) {
      rejected.push(rejection(candidate, "missing-hypothesis", [issue("$.sourceHypothesisId", "unknown_reference")]));
      continue;
    }
    if (isBaseRevisionMismatch(patch, input.repositoryRevision)) {
      rejected.push(rejection(candidate, "base-revision-mismatch", [issue("$.baseRevision", "mismatch")]));
      continue;
    }

    const outOfScope = patch.touchedPaths.some((path) => !validRelativePath(path) || !pathInAnyScope(path, input.allowedPaths));
    if (outOfScope) {
      rejected.push(rejection(candidate, "out-of-scope", [issue("$.touchedPaths", "path_out_of_scope")]));
      continue;
    }

    const cited = hypothesisEvidence.get(hypothesis.id);
    const hasContradiction = hypothesis.status === "rejected"
      || hypothesis.contradictingEvidenceIds.length > 0
      || (cited?.citations.some((citation) => citation.relation === "contradicts"
        && (!hasEvidenceContext || evidence.has(citation.evidenceId))) ?? false);
    if (hasContradiction) {
      rejected.push(rejection(candidate, "contradictory", [issue("$.sourceHypothesisId", "contradicting_evidence")]));
      continue;
    }

    const knownSupport = hypothesis.supportingEvidenceIds.filter((id) => !hasEvidenceContext || evidence.has(id));
    const citedSupport = cited?.citations.some((citation) => citation.relation === "supports"
      && hypothesis.supportingEvidenceIds.includes(citation.evidenceId)
      && (!hasEvidenceContext || evidence.has(citation.evidenceId))) ?? false;
    if (knownSupport.length === 0 && !citedSupport) {
      rejected.push(rejection(candidate, "unsupported", [issue("$.sourceHypothesisId", "missing_supporting_evidence")]));
      continue;
    }

    accepted.push({
      patch,
      scores: scorePatch(patch, hypothesis, input, evidence, hasEvidenceContext, cited, weights),
      rank: 0,
    });
  }

  accepted.sort(compareRankedPatches);
  const ranked = accepted.map((item, index) => ({ ...item, rank: index + 1 }));
  rejected.sort((left, right) => {
    const leftKey = `${left.candidatePatchId ?? ""}\u0000${left.reason}`;
    const rightKey = `${right.candidatePatchId ?? ""}\u0000${right.reason}`;
    const byIdentity = compareStrings(leftKey, rightKey);
    if (byIdentity !== 0) return byIdentity;
    return compareStrings(stableUnknownKey(left.candidate), stableUnknownKey(right.candidate));
  });
  return { accepted: ranked, rejected };
}

export const rankPatches = rankCandidatePatches;

/** Convenience adapter for callers that already have an IncidentManifest. */
export function rankManifestCandidatePatches(
  manifest: Pick<IncidentManifest, "allowedPaths" | "reproductionCommand" | "repositoryRevision">,
  candidates: readonly unknown[],
  hypotheses: readonly Hypothesis[],
  options: Omit<CandidatePatchRankingInput, "allowedPaths" | "reproductionCommand" | "repositoryRevision" | "candidates" | "hypotheses"> = {},
): CandidatePatchRankingResult {
  return rankCandidatePatches({
    ...options,
    candidates,
    hypotheses,
    allowedPaths: manifest.allowedPaths,
    reproductionCommand: manifest.reproductionCommand,
    repositoryRevision: manifest.repositoryRevision,
  });
}
