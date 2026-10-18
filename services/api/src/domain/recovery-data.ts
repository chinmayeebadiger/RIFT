import type {
  CandidatePatch,
  Hypothesis,
  HypothesisSet,
  JsonValue,
  Sha256Hash,
  ValidationIssue,
} from "@rift/core";
import { sha256 } from "./hashing.js";
import { demoIncidents } from "./incidents.js";
import { validateCandidatePatch, validateHypothesisSet } from "./validators.js";

export interface IncidentRecoveryData {
  readonly hypothesisSet: HypothesisSet;
  readonly patches: readonly CandidatePatch[];
}

export class RecoveryFixtureValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super("Recovery fixture data failed contract validation");
    this.name = "RecoveryFixtureValidationError";
    this.issues = issues;
  }
}

function withContentHash<const T extends Record<string, unknown>>(
  value: T,
): T & { readonly contentHash: Sha256Hash } {
  return { ...value, contentHash: sha256(value as unknown as JsonValue) };
}

function recoveryDataForEmptyIncident(incidentId: string): IncidentRecoveryData {
  return {
    hypothesisSet: withContentHash({
      kind: "HypothesisSet",
      schemaVersion: 1,
      id: `${incidentId.toLowerCase()}-hypotheses`,
      incidentId,
      correlationId: `${incidentId.toLowerCase()}-demo-run`,
      createdAt: "2026-10-18T10:00:00.000Z",
      hypotheses: [],
      rankingMethod: "confidence-desc",
    }),
    patches: [],
  };
}

const RIFT_042_HYPOTHESIS_POOL: Hypothesis = withContentHash({
  kind: "Hypothesis",
  schemaVersion: 1,
  id: "rift-042-hypothesis-connection-pool",
  incidentId: "RIFT-042",
  correlationId: "rift-042-demo-run",
  createdAt: "2026-10-18T10:00:00.000Z",
  statement: "Overlapping payment retries retain connections until the checkout pool is exhausted.",
  status: "confirmed",
  confidence: 0.91,
  supportingEvidenceIds: ["rift-042-evidence-retry-pool"],
  contradictingEvidenceIds: [],
  assumptions: ["The incident reproduction uses the production retry path."],
  nextCheck: "Run the checkout retry regression with connection release tracing enabled.",
});

const RIFT_042_HYPOTHESIS_BACKOFF: Hypothesis = withContentHash({
  kind: "Hypothesis",
  schemaVersion: 1,
  id: "rift-042-hypothesis-retry-backoff",
  incidentId: "RIFT-042",
  correlationId: "rift-042-demo-run",
  createdAt: "2026-10-18T10:00:00.000Z",
  statement: "Retry attempts are immediate, creating a burst that amplifies transient payment failures.",
  status: "open",
  confidence: 0.78,
  supportingEvidenceIds: ["rift-042-evidence-retry-pool"],
  contradictingEvidenceIds: [],
  assumptions: ["Payment provider failures are transient during the reproduction window."],
  nextCheck: "Compare retry timing and pool utilization with bounded exponential backoff enabled.",
});

const RIFT_042_HYPOTHESIS_SET: HypothesisSet = withContentHash({
  kind: "HypothesisSet",
  schemaVersion: 1,
  id: "rift-042-hypotheses",
  incidentId: "RIFT-042",
  correlationId: "rift-042-demo-run",
  createdAt: "2026-10-18T10:00:00.000Z",
  hypotheses: [RIFT_042_HYPOTHESIS_POOL, RIFT_042_HYPOTHESIS_BACKOFF],
  rankingMethod: "confidence-desc",
});

const RIFT_042_PATCHES: readonly CandidatePatch[] = [
  withContentHash({
    kind: "CandidatePatch",
    schemaVersion: 1,
    id: "rift-042-patch-release-connection",
    incidentId: "RIFT-042",
    correlationId: "rift-042-demo-run",
    createdAt: "2026-10-18T10:00:00.000Z",
    sourceHypothesisId: RIFT_042_HYPOTHESIS_POOL.id,
    baseRevision: { repository: "payments-platform", revision: "8f3a1d2" },
    diff: "diff --git a/src/checkout/payment-retry.ts b/src/checkout/payment-retry.ts\\n@@\\n- return paymentClient.retry(request);\\n+ try { return await paymentClient.retry(request); } finally { pool.release(connection); }",
    touchedPaths: ["src/checkout/payment-retry.ts"],
    rationale: "Release the checkout connection after each retry so overlapping payment attempts cannot exhaust the pool.",
    expectedInvariant: "Every payment retry releases its acquired connection exactly once.",
    generatedBy: { actor: "fake-model", model: "rift-demo-patch-generator" },
  }),
  withContentHash({
    kind: "CandidatePatch",
    schemaVersion: 1,
    id: "rift-042-patch-bounded-backoff",
    incidentId: "RIFT-042",
    correlationId: "rift-042-demo-run",
    createdAt: "2026-10-18T10:00:00.000Z",
    sourceHypothesisId: RIFT_042_HYPOTHESIS_BACKOFF.id,
    baseRevision: { repository: "payments-platform", revision: "8f3a1d2" },
    diff: "diff --git a/src/checkout/payment-retry.ts b/src/checkout/payment-retry.ts\\n@@\\n- const delay = 0;\\n+ const delay = Math.min(250 * 2 ** attempt, 2000);\\n+ await sleep(delay);",
    touchedPaths: ["src/checkout/payment-retry.ts"],
    rationale: "Add bounded exponential backoff between payment retries to prevent a transient failure burst from saturating the pool.",
    expectedInvariant: "Retry delay never exceeds two seconds and every retry remains bounded.",
    generatedBy: { actor: "fake-model", model: "rift-demo-patch-generator" },
  }),
];

const RIFT_042_DATA: IncidentRecoveryData = {
  hypothesisSet: RIFT_042_HYPOTHESIS_SET,
  patches: RIFT_042_PATCHES,
};

const RIFT_039_REJECTED_HYPOTHESIS: Hypothesis = withContentHash({
  kind: "Hypothesis",
  schemaVersion: 1,
  id: "rift-039-hypothesis-key-window",
  incidentId: "RIFT-039",
  correlationId: "rift-039-demo-run",
  createdAt: "2026-10-18T10:00:00.000Z",
  statement: "The key rotation window is shared consistently across identity replicas.",
  status: "rejected",
  confidence: 0.18,
  supportingEvidenceIds: [],
  contradictingEvidenceIds: ["rift-039-evidence-key-window"],
  assumptions: ["All identity replicas received the same rotation configuration."],
  nextCheck: "Collect replica configuration evidence before proposing a patch.",
});

const RIFT_039_DATA: IncidentRecoveryData = {
  hypothesisSet: withContentHash({
    kind: "HypothesisSet",
    schemaVersion: 1,
    id: "rift-039-hypotheses",
    incidentId: "RIFT-039",
    correlationId: "rift-039-demo-run",
    createdAt: "2026-10-18T10:00:00.000Z",
    hypotheses: [RIFT_039_REJECTED_HYPOTHESIS],
    rankingMethod: "confidence-desc",
  }),
  patches: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Validate data before it can be returned from the read-only API. */
export function validateRecoveryData(value: unknown): IncidentRecoveryData {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    throw new RecoveryFixtureValidationError([{ path: "$", code: "invalid_type" }]);
  }

  const hypothesisSetResult = validateHypothesisSet(value.hypothesisSet);
  if (!hypothesisSetResult.ok) issues.push(...hypothesisSetResult.issues.map((entry) => ({ path: `$.hypothesisSet${entry.path.slice(1)}`, code: entry.code })));

  if (!Array.isArray(value.patches)) {
    issues.push({ path: "$.patches", code: "invalid_type" });
  } else {
    const hypothesisIds = new Set(
      hypothesisSetResult.ok ? hypothesisSetResult.value.hypotheses.map((hypothesis) => hypothesis.id) : [],
    );
    value.patches.forEach((patch, index) => {
      const result = validateCandidatePatch(patch);
      if (!result.ok) issues.push(...result.issues.map((entry) => ({ path: `$.patches[${index}]${entry.path.slice(1)}`, code: entry.code })));
      if (isRecord(patch) && typeof patch.sourceHypothesisId === "string" && !hypothesisIds.has(patch.sourceHypothesisId)) {
        issues.push({ path: `$.patches[${index}].sourceHypothesisId`, code: "unknown_hypothesis" });
      }
    });
  }

  if (issues.length > 0) throw new RecoveryFixtureValidationError(issues);
  return value as unknown as IncidentRecoveryData;
}

const dataByIncident: Record<string, IncidentRecoveryData> = Object.fromEntries(
  demoIncidents.map((incident) => [
    incident.id,
    incident.id === "RIFT-042"
      ? RIFT_042_DATA
      : incident.id === "RIFT-039"
        ? RIFT_039_DATA
        : recoveryDataForEmptyIncident(incident.id),
  ]),
);

for (const data of Object.values(dataByIncident)) validateRecoveryData(data);

export function findRecoveryData(incidentId: string): IncidentRecoveryData | undefined {
  return dataByIncident[incidentId];
}
