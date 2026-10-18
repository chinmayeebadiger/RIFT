import type {
  EvidenceId,
  EvidenceItem,
  Hypothesis,
  HypothesisSet,
  JsonValue,
} from "./contracts.js";
import { sha256 } from "./hashing.js";
import { validateEvidenceItem, validateHypothesisSet, validateTimestamp } from "./validators.js";

/** A normalized observation is a fact; it is never a causal conclusion. */
export interface NormalizedEvidence {
  readonly evidenceId: EvidenceId;
  readonly kind: "fact";
  readonly text: string;
  readonly sourceType: string;
  readonly locator: string;
  readonly capturedAt: string;
}

export interface FailureSignature {
  readonly id: string;
  readonly name: string;
  readonly status: number | string;
  readonly message: string;
  readonly evidenceIds: readonly EvidenceId[];
}

export interface FailureSignatureInput {
  readonly name: string;
  readonly status: number | string;
  readonly message: string;
  readonly evidenceIds?: readonly EvidenceId[];
}

export interface HypothesisEngineInput {
  readonly incidentId: string;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly evidence: readonly EvidenceItem[] | readonly NormalizedEvidence[];
  readonly failureSignatures?: readonly FailureSignatureInput[];
  readonly maxHypotheses?: number;
}

export interface EvidenceFact {
  readonly evidenceId: EvidenceId;
  readonly statement: string;
}

export interface InferenceRecord {
  readonly hypothesisId: string;
  readonly statement: string;
  readonly supportingEvidenceIds: readonly EvidenceId[];
  readonly contradictingEvidenceIds: readonly EvidenceId[];
}

export interface HypothesisEngineResult {
  /** The persisted contract. Its statements are inferences, not facts. */
  readonly hypothesisSet: HypothesisSet;
  /** Facts retain their immutable evidence citation and are separate from inferences. */
  readonly facts: readonly EvidenceFact[];
  readonly inferences: readonly InferenceRecord[];
  readonly normalizedEvidence: readonly NormalizedEvidence[];
  readonly failureSignatures: readonly FailureSignature[];
}

export class HypothesisEngineInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "HypothesisEngineInputError";
  }
}

interface HypothesisRule {
  readonly key: string;
  readonly statement: string;
  readonly supportTerms: readonly string[];
  readonly contradictionTerms: readonly string[];
  readonly assumptions: readonly string[];
  readonly nextCheck: string;
}

interface CandidateEvaluation {
  readonly rule: HypothesisRule;
  readonly supportingEvidenceIds: readonly EvidenceId[];
  readonly contradictingEvidenceIds: readonly EvidenceId[];
  readonly matchedSignatureIds: readonly string[];
  readonly score: number;
}

const KNOWN_RULES: readonly HypothesisRule[] = [
  {
    key: "duplicate-discount",
    statement: "The checkout discount is applied more than once.",
    supportTerms: ["discount twice", "applied twice", "double discount", "discount duplicated", "discount=twice"],
    contradictionTerms: ["discount applied once", "single discount", "discount only once", "no duplicate discount"],
    assumptions: ["The recorded checkout path is the path used by the failing request."],
    nextCheck: "Run the checkout reproduction with a trace around discount application and count the discount operations.",
  },
  {
    key: "negative-quantity",
    statement: "Cart quantity validation permits a negative quantity.",
    supportTerms: ["negative quantity", "quantity=-", "qty=-", "negative cart quantity", "quantity below zero"],
    contradictionTerms: ["quantity is non-negative", "quantity >= 0", "negative quantity rejected", "quantity validation passed"],
    assumptions: ["The reported quantity belongs to the cart mutation under investigation."],
    nextCheck: "Replay the cart mutation with a negative quantity and assert that the boundary rejects it before persistence.",
  },
  {
    key: "expired-coupon",
    statement: "Coupon validation accepts an expired coupon.",
    supportTerms: ["expired coupon", "coupon expired", "welcome10 expired", "expired welcome10", "expired promotion"],
    contradictionTerms: ["coupon is valid", "coupon not expired", "expired coupon rejected", "promotion still active"],
    assumptions: ["The fixture clock is the intended clock for coupon validity."],
    nextCheck: "Replay coupon validation at the fixture timestamp and assert that the expiry boundary rejects the coupon.",
  },
  {
    key: "case-sensitive-search",
    statement: "Product search compares terms case-sensitively.",
    supportTerms: ["case-sensitive", "case sensitive", "misses hoodie", "hoodie search", "search mismatch"],
    contradictionTerms: ["case-insensitive", "case insensitive", "search matches hoodie", "search normalized case"],
    assumptions: ["The search term and product name are expected to match without case distinction."],
    nextCheck: "Replay the search with mixed-case input and assert that matching normalizes both operands.",
  },
  {
    key: "connection-pool-exhaustion",
    statement: "Retry behavior exhausts the database connection pool.",
    supportTerms: ["connection pool", "pool exhausted", "payment retries", "retries exhausting", "too many connections"],
    contradictionTerms: ["connection pool available", "no pool exhaustion", "retry succeeded", "connection released"],
    assumptions: ["The connection-pool observation belongs to the failing payment request."],
    nextCheck: "Replay the payment failure with connection-pool instrumentation and compare checkout retries with releases.",
  },
  {
    key: "retry-budget-exhaustion",
    statement: "Checkout retry handling exhausts the configured retry budget.",
    supportTerms: ["retry budget exhausted", "retry pool exhausted", "retry exhaustion", "retries exhausted"],
    contradictionTerms: ["retry budget available", "retry completed", "no retries required"],
    assumptions: ["The retry-budget failure is the primary checkout failure rather than a downstream symptom."],
    nextCheck: "Replay the checkout failure with retry counters and assert where the budget is consumed and released.",
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/[\t\r\n ]+/gu, " ").trim();
}

function contentText(content: JsonValue): string {
  if (typeof content === "string") return content;
  if (content === null || typeof content === "number" || typeof content === "boolean") return String(content);
  if (Array.isArray(content)) return content.map(contentText).join(" ");
  const object = content as { readonly [key: string]: JsonValue };
  return Object.keys(object)
    .sort()
    .map((key) => `${key}=${contentText(object[key])}`)
    .join(" ");
}

function normalizedText(content: JsonValue): string {
  return normalizeWhitespace(contentText(content));
}

function lower(value: string): string {
  return value.toLocaleLowerCase("en-US");
}

function sortIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right, "en-US"));
}

function asEvidenceIdList(value: unknown): EvidenceId[] {
  return Array.isArray(value) ? sortIds(value.filter((item): item is string => typeof item === "string")) : [];
}

function isNormalizedEvidence(value: EvidenceItem | NormalizedEvidence): value is NormalizedEvidence {
  return value.kind === "fact" && "evidenceId" in value;
}

/** Convert immutable evidence payloads into stable, fact-only observations. */
export function normalizeEvidence(evidence: readonly EvidenceItem[]): readonly NormalizedEvidence[] {
  const normalized = evidence.map((item) => {
    const validation = validateEvidenceItem(item);
    if (!validation.ok) {
      throw new HypothesisEngineInputError(`Evidence ${item.id} is invalid: ${validation.issues.map((entry) => entry.code).join(",")}`);
    }
    return {
      evidenceId: item.id,
      kind: "fact" as const,
      text: normalizedText(item.content),
      sourceType: item.source.type,
      locator: item.source.locator,
      capturedAt: item.capturedAt,
    };
  });
  return normalized.sort((left, right) => left.evidenceId.localeCompare(right.evidenceId, "en-US"));
}

function normalizeProvidedEvidence(evidence: HypothesisEngineInput["evidence"]): readonly NormalizedEvidence[] {
  if (evidence.some(isNormalizedEvidence)) {
    const normalized = evidence.map((item) => {
      if (!isNormalizedEvidence(item)) throw new HypothesisEngineInputError("Evidence input mixes raw and normalized evidence");
      if (!item.evidenceId || !item.text.trim() || !item.capturedAt) throw new HypothesisEngineInputError("Normalized evidence is incomplete");
      return { ...item, text: normalizeWhitespace(item.text), kind: "fact" as const };
    });
    return normalized.sort((left, right) => left.evidenceId.localeCompare(right.evidenceId, "en-US"));
  }
  return normalizeEvidence(evidence as readonly EvidenceItem[]);
}

function signatureId(signature: FailureSignatureInput): string {
  return `signature-${sha256({ name: signature.name, status: signature.status, message: signature.message } as unknown as JsonValue).slice(7, 23)}`;
}

function signatureFromLine(line: string, evidenceId: EvidenceId): FailureSignatureInput | undefined {
  const match = /signature=([^\s]+)(?:\s+status=([^\s]+))?\s+message="([^"]+)"/u.exec(line);
  if (!match) return undefined;
  const statusValue = match[2] ?? /\bstatus=(\d+)\b/u.exec(line)?.[1] ?? "error";
  const status = /^\d+$/u.test(statusValue) ? Number(statusValue) : statusValue;
  return { name: match[1], status, message: match[3], evidenceIds: [evidenceId] };
}

function signatureFromContent(item: NormalizedEvidence, originalContent?: JsonValue): FailureSignatureInput | undefined {
  const fromLine = signatureFromLine(item.text, item.evidenceId);
  if (fromLine) return fromLine;
  if (isRecord(originalContent)) {
    const name = originalContent.signature ?? originalContent.name ?? originalContent.error;
    const message = originalContent.message ?? originalContent.detail;
    const status = originalContent.status ?? originalContent.statusCode;
    if ((typeof name === "string" || typeof message === "string") && (typeof status === "string" || typeof status === "number")) {
      return {
        name: typeof name === "string" ? name : "application-failure",
        status,
        message: typeof message === "string" ? message : String(name),
        evidenceIds: [item.evidenceId],
      };
    }
  }
  const error = /\b([A-Za-z][\w.]*(?:Error|Exception))\b(?::\s*([^\n]+))?/u.exec(item.text);
  if (error) return { name: error[1], status: "error", message: normalizeWhitespace(error[2] ?? error[1]), evidenceIds: [item.evidenceId] };
  return undefined;
}

/** Extract structured failure signatures without inventing timestamps or external state. */
export function extractFailureSignatures(
  evidence: readonly EvidenceItem[] | readonly NormalizedEvidence[],
  provided: readonly FailureSignatureInput[] = [],
): readonly FailureSignature[] {
  const rawById = new Map<string, JsonValue>();
  if (evidence.length > 0 && !isNormalizedEvidence(evidence[0])) {
    for (const item of evidence as readonly EvidenceItem[]) rawById.set(item.id, item.content);
  }
  const normalized = evidence.length > 0 && isNormalizedEvidence(evidence[0])
    ? evidence as readonly NormalizedEvidence[]
    : normalizeEvidence(evidence as readonly EvidenceItem[]);
  const generated = normalized.flatMap((item) => {
    const signature = signatureFromLine(item.text, item.evidenceId) ?? signatureFromContent(item, rawById.get(item.evidenceId));
    return signature ? [signature] : [];
  });
  const all = [...provided, ...generated];
  const byKey = new Map<string, FailureSignatureInput>();
  for (const signature of all) {
    const key = `${signature.name}\u0000${String(signature.status)}\u0000${signature.message}`;
    const previous = byKey.get(key);
    byKey.set(key, {
      name: signature.name,
      status: signature.status,
      message: signature.message,
      evidenceIds: sortIds([...(previous?.evidenceIds ?? []), ...(signature.evidenceIds ?? [])]),
    });
  }
  const knownEvidenceIds = new Set(normalized.map((item) => item.evidenceId));
  return [...byKey.values()]
    .map((signature) => ({
      ...signature,
      id: signatureId(signature),
      evidenceIds: asEvidenceIdList(signature.evidenceIds).filter((id) => knownEvidenceIds.has(id)),
    }))
    .sort((left, right) => left.id.localeCompare(right.id, "en-US"));
}

function includesTerm(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => text.includes(lower(term)));
}

function genericRule(signature: FailureSignature): HypothesisRule {
  return {
    key: `signature-${signature.id}`,
    statement: `The ${signature.name} failure is caused by an application defect at the recorded failure site.`,
    supportTerms: [lower(signature.name), lower(signature.message)],
    contradictionTerms: [`${lower(signature.name)} resolved`, `no ${lower(signature.name)} failure`],
    assumptions: ["The recorded failure signature is representative of the incident rather than a secondary symptom."],
    nextCheck: `Reproduce ${signature.name} and isolate the first failing operation before downstream retries or error handling.`,
  };
}

function evaluateRule(rule: HypothesisRule, evidence: readonly NormalizedEvidence[], signatures: readonly FailureSignature[]): CandidateEvaluation {
  const supporting = new Set<EvidenceId>();
  const contradicting = new Set<EvidenceId>();
  const matchedSignatures = new Set<string>();
  for (const item of evidence) {
    const text = lower(item.text);
    if (includesTerm(text, rule.supportTerms)) supporting.add(item.evidenceId);
    if (includesTerm(text, rule.contradictionTerms)) contradicting.add(item.evidenceId);
  }
  for (const signature of signatures) {
    const signatureText = lower(`${signature.name} ${signature.message}`);
    if (includesTerm(signatureText, rule.supportTerms)) {
      matchedSignatures.add(signature.id);
      signature.evidenceIds.forEach((id) => supporting.add(id));
    }
    if (includesTerm(signatureText, rule.contradictionTerms)) signature.evidenceIds.forEach((id) => contradicting.add(id));
  }
  const score = supporting.size * 4 + matchedSignatures.size * 2 - contradicting.size * 5;
  return {
    rule,
    supportingEvidenceIds: sortIds(supporting),
    contradictingEvidenceIds: sortIds(contradicting),
    matchedSignatureIds: sortIds(matchedSignatures),
    score,
  };
}

function roundedConfidence(evaluation: CandidateEvaluation): number {
  const value = 0.2
    + evaluation.supportingEvidenceIds.length * 0.2
    + evaluation.matchedSignatureIds.length * 0.15
    - evaluation.contradictingEvidenceIds.length * 0.2;
  return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
}

function statusFor(evaluation: CandidateEvaluation, confidence: number): Hypothesis["status"] {
  if (evaluation.supportingEvidenceIds.length === 0 && evaluation.contradictingEvidenceIds.length > 0) return "rejected";
  if (confidence >= 0.75 && evaluation.contradictingEvidenceIds.length === 0) return "confirmed";
  if (evaluation.supportingEvidenceIds.length === 0) return "open";
  return "inconclusive";
}

function buildHypothesis(input: HypothesisEngineInput, evaluation: CandidateEvaluation): Hypothesis {
  const confidence = roundedConfidence(evaluation);
  const status = statusFor(evaluation, confidence);
  const assumptions = [...evaluation.rule.assumptions];
  if (evaluation.contradictingEvidenceIds.length > 0) assumptions.push("Contradicting evidence must be reconciled by the next check.");
  const withoutHash: Omit<Hypothesis, "contentHash"> = {
    kind: "Hypothesis",
    schemaVersion: 1,
    id: `hypothesis-${sha256({ key: evaluation.rule.key, statement: evaluation.rule.statement, supportingEvidenceIds: evaluation.supportingEvidenceIds, contradictingEvidenceIds: evaluation.contradictingEvidenceIds } as unknown as JsonValue).slice(7, 23)}`,
    incidentId: input.incidentId,
    correlationId: input.correlationId,
    createdAt: input.createdAt,
    statement: evaluation.rule.statement,
    status,
    confidence,
    supportingEvidenceIds: evaluation.supportingEvidenceIds,
    contradictingEvidenceIds: evaluation.contradictingEvidenceIds,
    assumptions,
    nextCheck: evaluation.rule.nextCheck,
  };
  return { ...withoutHash, contentHash: sha256(withoutHash as unknown as JsonValue) };
}

function assembleHypothesisSet(input: HypothesisEngineInput, hypotheses: readonly Hypothesis[]): HypothesisSet {
  const withoutHash: Omit<HypothesisSet, "contentHash"> = {
    kind: "HypothesisSet",
    schemaVersion: 1,
    id: `hypotheses-${sha256({ incidentId: input.incidentId, correlationId: input.correlationId, createdAt: input.createdAt, hypotheses } as unknown as JsonValue).slice(7, 23)}`,
    incidentId: input.incidentId,
    correlationId: input.correlationId,
    createdAt: input.createdAt,
    hypotheses,
    rankingMethod: "deterministic-evidence-v1: support=4, signature=2, contradiction=-5; ties=statement",
  };
  return { ...withoutHash, contentHash: sha256(withoutHash as unknown as JsonValue) };
}

/**
 * Run the complete offline investigation step. No provider, filesystem, network,
 * sandbox, or clock is consulted; the supplied timestamp is part of the replay input.
 */
export function runHypothesisEngine(input: HypothesisEngineInput): HypothesisEngineResult {
  if (!validateTimestamp(input.createdAt).ok) throw new HypothesisEngineInputError("createdAt must be a canonical UTC timestamp");
  if (!input.incidentId || !input.correlationId) throw new HypothesisEngineInputError("incidentId and correlationId are required");
  const normalized = normalizeProvidedEvidence(input.evidence);
  const signatures = extractFailureSignatures(input.evidence, input.failureSignatures);
  const genericRules = signatures
    .filter((signature) => !KNOWN_RULES.some((rule) => includesTerm(lower(`${signature.name} ${signature.message}`), rule.supportTerms)))
    .map(genericRule);
  const rules = [...KNOWN_RULES, ...genericRules];
  const evaluations = rules
    .map((rule) => evaluateRule(rule, normalized, signatures))
    .filter((evaluation) => evaluation.supportingEvidenceIds.length > 0 || evaluation.contradictingEvidenceIds.length > 0)
    .sort((left, right) => right.score - left.score || left.rule.statement.localeCompare(right.rule.statement, "en-US"));
  const limit = input.maxHypotheses === undefined ? evaluations.length : Math.max(0, Math.floor(input.maxHypotheses));
  const hypotheses = evaluations.slice(0, limit).map((evaluation) => buildHypothesis(input, evaluation));
  const hypothesisSet = assembleHypothesisSet(input, hypotheses);
  const validation = validateHypothesisSet(hypothesisSet);
  if (!validation.ok) throw new HypothesisEngineInputError(`Engine produced invalid HypothesisSet: ${validation.issues.map((entry) => `${entry.path}:${entry.code}`).join(",")}`);
  const facts = normalized.map((item) => ({ evidenceId: item.evidenceId, statement: item.text }));
  const inferences = hypotheses.map((hypothesis) => ({
    hypothesisId: hypothesis.id,
    statement: hypothesis.statement,
    supportingEvidenceIds: hypothesis.supportingEvidenceIds,
    contradictingEvidenceIds: hypothesis.contradictingEvidenceIds,
  }));
  return { hypothesisSet, facts, inferences, normalizedEvidence: normalized, failureSignatures: signatures };
}

/** Generate the schema-valid persisted contract when callers do not need the audit view. */
export function generateHypothesisSet(input: HypothesisEngineInput): HypothesisSet {
  return runHypothesisEngine(input).hypothesisSet;
}

export const buildHypothesisSet = generateHypothesisSet;
