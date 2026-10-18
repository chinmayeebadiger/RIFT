import type { EvidenceItem, JsonValue } from "./contracts.js";
import { computeEvidenceHash } from "./hashing.js";

export const REDACTION_PLACEHOLDER = "[REDACTED]";

export class EvidenceRedactionError extends Error {
  public readonly code = "EVIDENCE_REDACTION_FAILED" as const;

  public constructor(message: string) {
    super(message);
    this.name = "EvidenceRedactionError";
  }
}

export interface RedactionResult {
  readonly value: JsonValue;
  readonly redacted: boolean;
  readonly rules: readonly string[];
}

interface SecretRule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string;
}

const SECRET_RULES: readonly SecretRule[] = [
  {
    name: "private-key",
    pattern: /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu,
    replacement: REDACTION_PLACEHOLDER,
  },
  {
    name: "connection-string",
    pattern: /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"']+/giu,
    replacement: REDACTION_PLACEHOLDER,
  },
  {
    name: "bearer-token",
    pattern: /\bBearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+\/-]+=*/giu,
    replacement: `Bearer ${REDACTION_PLACEHOLDER}`,
  },
  {
    name: "aws-access-key",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
    replacement: REDACTION_PLACEHOLDER,
  },
  {
    name: "github-token",
    pattern: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]+\b/gu,
    replacement: REDACTION_PLACEHOLDER,
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
    replacement: REDACTION_PLACEHOLDER,
  },
  {
    name: "credential-assignment",
    pattern: /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']?(?!Bearer\b|\[REDACTED\])[^\s,"'}]+/giu,
    replacement: REDACTION_PLACEHOLDER,
  },
  {
    name: "secret-assignment",
    pattern: /\b(?:password|passwd|secret|token)\s*[:=]\s*["']?(?!\[REDACTED\])[^\s,"'}]+/giu,
    replacement: REDACTION_PLACEHOLDER,
  },
];

const SENSITIVE_KEY = /(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|authorization)/iu;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redactString(value: string): RedactionResult {
  let redactedValue = value;
  const rules = new Set<string>();
  for (const rule of SECRET_RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(redactedValue)) {
      rules.add(rule.name);
      rule.pattern.lastIndex = 0;
      redactedValue = redactedValue.replace(rule.pattern, rule.replacement);
    }
  }
  return { value: redactedValue, redacted: rules.size > 0, rules: [...rules].sort() };
}

function redactValue(value: unknown, path: string, inheritedSensitiveKey = false): RedactionResult {
  if (typeof value === "string") {
    if (inheritedSensitiveKey && value !== REDACTION_PLACEHOLDER) {
      return { value: REDACTION_PLACEHOLDER, redacted: true, rules: ["sensitive-field"] };
    }
    return redactString(value);
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new EvidenceRedactionError(`Cannot redact non-finite value at ${path}`);
    }
    return { value, redacted: false, rules: [] };
  }
  if (Array.isArray(value)) {
    const results = value.map((item, index) => redactValue(item, `${path}[${index}]`));
    return {
      value: results.map((result) => result.value),
      redacted: results.some((result) => result.redacted),
      rules: [...new Set(results.flatMap((result) => result.rules))].sort(),
    };
  }
  if (!isPlainRecord(value)) {
    throw new EvidenceRedactionError(`Unsupported value at ${path}`);
  }

  const output: Record<string, JsonValue> = {};
  let redacted = false;
  const rules = new Set<string>();
  for (const key of Object.keys(value)) {
    const result = redactValue(value[key], `${path}.${key}`, SENSITIVE_KEY.test(key));
    output[key] = result.value;
    redacted ||= result.redacted;
    result.rules.forEach((rule) => rules.add(rule));
  }
  return { value: output, redacted, rules: [...rules].sort() };
}

/** Redact secrets recursively without mutating the caller's value. */
export function redactSecrets(value: unknown): RedactionResult {
  try {
    return redactValue(value, "$");
  } catch (error) {
    if (error instanceof EvidenceRedactionError) throw error;
    throw new EvidenceRedactionError(
      `Unable to redact value: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

/**
 * Return the only form of evidence that may cross the model boundary.
 * Pending redaction is rejected rather than guessed safe, and the returned
 * contract gets a new hash because redaction changes the payload.
 */
export function redactEvidenceForModel(item: EvidenceItem): EvidenceItem {
  if (item.redaction.status === "pending") {
    throw new EvidenceRedactionError(`Evidence item is pending redaction: ${item.id}`);
  }

  const result = redactSecrets(item);
  const redaction = {
    status: result.redacted || item.redaction.status === "redacted" ? ("redacted" as const) : ("not-required" as const),
    rules: [...new Set([...(item.redaction.rules ?? []), ...result.rules])].sort(),
  };
  const { contentHash: _originalHash, ...withoutHash } = result.value as unknown as EvidenceItem;
  const safeItem = { ...withoutHash, redaction } as Omit<EvidenceItem, "contentHash">;
  return { ...safeItem, contentHash: computeEvidenceHash(safeItem) };
}

export function assertModelSafeEvidence(item: EvidenceItem): void {
  const safe = redactEvidenceForModel(item);
  const secondPass = redactSecrets(safe);
  if (secondPass.redacted || safe.redaction.status === "pending") {
    throw new EvidenceRedactionError(`Evidence item did not reach a redaction-safe state: ${item.id}`);
  }
}
