import { CONTRACT_SCHEMA_VERSION, type CandidatePatch, type JsonValue } from "@rift/core";
import { canonicalJson, sha256 } from "../domain/hashing.js";
import type { CandidatePatchModelInput, CandidatePatchProvider } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseInput(input: string): CandidatePatchModelInput {
  const value: unknown = JSON.parse(input);
  if (!isRecord(value) || value.schemaVersion !== CONTRACT_SCHEMA_VERSION) {
    throw new Error("Fake model received an unsupported input fixture");
  }
  return value as unknown as CandidatePatchModelInput;
}

/**
 * Offline provider used by tests and local replay. It is a pure JSON function:
 * it has no filesystem, process, network, or tool access.
 */
export class DeterministicFakeModel implements CandidatePatchProvider {
  public readonly name = "fake-model";

  public async generate(input: string, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new DOMException("The fake model was cancelled", "AbortError");
    const fixture = parseInput(input);
    const withoutHash: Omit<CandidatePatch, "contentHash"> = {
      kind: "CandidatePatch",
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      id: `patch-${fixture.inputHash.slice(7, 23)}`,
      incidentId: fixture.incidentId,
      correlationId: fixture.correlationId,
      createdAt: fixture.createdAt,
      sourceHypothesisId: fixture.hypothesisId,
      baseRevision: fixture.repositoryRevision,
      // CandidatePatch's bounded string contract intentionally excludes control
      // characters, so the diff is a single-line, transport-safe representation.
      diff: `diff --git a/${fixture.targetPath} b/${fixture.targetPath} | --- a/${fixture.targetPath} | +++ b/${fixture.targetPath} | @@ -1,1 +1,1 @@ | -Rift candidate for ${fixture.hypothesisId} | +Rift candidate for ${fixture.hypothesisId} (deterministic fake)`,
      touchedPaths: [fixture.targetPath],
      rationale: `Address hypothesis ${fixture.hypothesisId} in the selected source path.`,
      expectedInvariant: "The selected incident regression no longer occurs.",
      generatedBy: { actor: "fake-model", model: "rift-fake-model-v1" },
    };
    const proposal = { ...withoutHash, contentHash: sha256(withoutHash as unknown as JsonValue) };
    return JSON.stringify(proposal);
  }
}

export const FakeModelProvider = DeterministicFakeModel;
