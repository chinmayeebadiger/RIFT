import type {
  CandidatePatch,
  CorrelationId,
  EvidenceItem,
  Hypothesis,
  HypothesisSet,
  IncidentId,
  IncidentManifest,
  RepositoryRevision,
  RepositorySnapshot,
  Sha256Hash,
} from "@rift/core";
import type { InvestigationPortContext } from "../investigation/ports.js";

/** Patch workers receive the same incident/correlation context as M2 workers. */
export interface PatchPortContext extends InvestigationPortContext {
  readonly incidentId: IncidentId;
  readonly correlationId: CorrelationId;
}

export interface DiffValidationRequest extends PatchPortContext {
  readonly baseRevision: RepositoryRevision;
  readonly diff: string;
  readonly declaredTouchedPaths: readonly string[];
  readonly allowedPaths: readonly string[];
}

/** Parses and authorizes a diff; it never applies or executes one. */
export interface DiffValidator {
  validate(request: DiffValidationRequest): Promise<unknown>;
}

export interface PatchModelProposalRequest extends PatchPortContext {
  readonly sourceHypothesis: Hypothesis;
  readonly snapshot: RepositorySnapshot;
  readonly redactedEvidence: readonly EvidenceItem[];
  readonly inputHash: Sha256Hash;
  readonly allowedPaths: readonly string[];
}

/** Model output is untrusted and must be validated as a PatchModelProposal. */
export interface PatchModelAdapter {
  propose(request: PatchModelProposalRequest): Promise<unknown>;
}

export interface PatchRankingRequest extends PatchPortContext {
  readonly sourceHypothesis: Hypothesis;
  readonly candidatePatches: readonly CandidatePatch[];
}

/** Ranks validated candidates without approving, applying, or verifying them. */
export interface PatchRanker {
  rank(request: PatchRankingRequest): Promise<unknown>;
}

export interface PatchGenerationRequest extends PatchPortContext {
  readonly manifest: IncidentManifest;
  readonly snapshot: RepositorySnapshot;
  readonly hypothesisSet: HypothesisSet;
  readonly sourceHypothesis: Hypothesis;
  readonly evidence: readonly EvidenceItem[];
  readonly redactedEvidence: readonly EvidenceItem[];
}

/** Coordinates the patch boundary; it returns an untrusted API proposal. */
export interface PatchGenerator {
  generate(request: PatchGenerationRequest): Promise<unknown>;
}
