import { createHash } from "node:crypto";
import type { EvidenceItem, IncidentManifest, JsonValue } from "./contracts.js";
import type { EvidenceStore } from "./evidence-store.js";
import { validateIncidentManifest } from "./validators.js";

export const MAX_MANIFEST_BYTES = 256 * 1024;

export interface IntakeError {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export class ManifestValidationError extends Error {
  public readonly errors: readonly IntakeError[];
  public readonly statusCode: 400 | 403 | 413;

  public constructor(errors: readonly IntakeError[], statusCode: 400 | 403 | 413 = 400) {
    super(errors[0]?.message ?? "Manifest rejected");
    this.name = "ManifestValidationError";
    this.errors = errors;
    this.statusCode = statusCode;
  }
}

export interface IntakeOptions {
  readonly authorized?: boolean;
  readonly actor?: string;
}

export interface IntakeResult {
  readonly manifest: IncidentManifest;
  readonly manifestHash: string;
  readonly evidence: EvidenceItem;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

function hash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}

function issueCode(code: string): string {
  const names: Record<string, string> = {
    invalid_type: "INVALID_TYPE",
    missing_required: "REQUIRED_FIELD",
    missing: "REQUIRED_FIELD",
    empty_string: "INVALID_VALUE",
    invalid_value: "INVALID_VALUE",
    unsupported_schema_version: "INVALID_VALUE",
    invalid_relative_path: "UNSAFE_PATH",
    duplicate_value: "DUPLICATE_PATH",
    too_long: "FIELD_TOO_LARGE",
    too_many_items: "LIST_TOO_LARGE",
    too_many_keys: "LIST_TOO_LARGE",
    unknown_key: "MALFORMED_MANIFEST",
  };
  return names[code] ?? `INVALID_${code.toUpperCase()}`;
}

function mapValidationIssues(issues: readonly { path: string; code: string }[]): IntakeError[] {
  return issues.map((issue) => ({ code: issueCode(issue.code), path: issue.path, message: `Manifest field is invalid (${issue.code})` }));
}

function scanSecrets(value: unknown, path: string, found: IntakeError[], depth = 0): void {
  if (typeof value === "string") {
    const secret = /-----BEGIN [^-]*PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:ghp|gho|ghs|xox[baprs])[-_A-Za-z0-9]{12,}\b|\bBearer\s+\S+|\b(?:api[_-]?key|token|password|passwd|secret)\s*[:=]\s*\S+/iu.test(value);
    if (secret) found.push({ code: "SECRET_INPUT", path, message: "Secret-bearing input is not accepted" });
    return;
  }
  if (depth > 20 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) value.forEach((item, index) => scanSecrets(item, `${path}[${index}]`, found, depth + 1));
  else Object.entries(value).forEach(([key, item]) => {
    const sensitiveKey = /(?:api[_-]?key|access[_-]?token|client[_-]?secret|credential|password|passwd|private[_-]?key|secret|token)/iu.test(key);
    if (sensitiveKey && typeof item === "string" && item.length > 0) {
      found.push({ code: "SECRET_INPUT", path: `${path}.${key}`, message: "Secret-bearing input is not accepted" });
    }
    scanSecrets(item, `${path}.${key}`, found, depth + 1);
  });
}

function normalizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const normalized = structuredClone(input) as Record<string, unknown>;
  const paths = normalized.allowedPaths;
  if (Array.isArray(paths)) normalized.allowedPaths = paths.map((path) => typeof path === "string" ? path.replaceAll("\\", "/") : path).sort();
  const sources = normalized.logSources;
  if (Array.isArray(sources)) normalized.logSources = sources.map((source) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) return source;
    const copy = { ...(source as Record<string, unknown>) };
    if (typeof copy.locator === "string") copy.locator = copy.locator.replaceAll("\\", "/");
    return copy;
  }).sort((left, right) => {
    const leftKey = canonical(left);
    const rightKey = canonical(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const commands = [normalized.reproductionCommand, ...(Array.isArray(normalized.testCommands) ? normalized.testCommands : [])];
  commands.forEach((command) => {
    if (command && typeof command === "object" && !Array.isArray(command)) {
      const item = command as Record<string, unknown>;
      if (typeof item.workingDirectory === "string") item.workingDirectory = item.workingDirectory.replaceAll("\\", "/");
    }
  });
  return normalized;
}

function policyAndExecutionIssues(input: Record<string, unknown>): IntakeError[] {
  const issues: IntakeError[] = [];
  const policy = input.policy;
  if (policy && typeof policy === "object" && !Array.isArray(policy)) {
    const record = policy as Record<string, unknown>;
    if (record.authorized === false || record.allow === false || record.authorization === "denied") {
      issues.push({ code: "POLICY_DENIED", path: "$.policy", message: "Manifest policy denies intake" });
    }
  }
  const commands = [{ path: "$.reproductionCommand", value: input.reproductionCommand }, ...(Array.isArray(input.testCommands) ? input.testCommands.map((value, index) => ({ path: `$.testCommands[${index}]`, value })) : [])];
  const policyRecord = input.policy && typeof input.policy === "object" && !Array.isArray(input.policy) ? input.policy as Record<string, unknown> : undefined;
  const allowedCommands = policyRecord && Array.isArray(policyRecord.allowedCommands) ? policyRecord.allowedCommands.filter((value): value is string => typeof value === "string") : undefined;
  for (const command of commands) {
    if (!command.value || typeof command.value !== "object" || Array.isArray(command.value)) continue;
    const record = command.value as Record<string, unknown>;
    if (typeof record.command === "string" && (/[;&|<>`$\u0000\n\r]/u.test(record.command) || /\s/u.test(record.command) || /^(?:sh|bash|zsh|fish|dash|cmd|powershell|pwsh)$/iu.test(record.command))) {
      issues.push({ code: "UNSAFE_COMMAND", path: `${command.path}.command`, message: "Command must be a single executable without shell syntax" });
    }
    if (allowedCommands !== undefined && typeof record.command === "string" && !allowedCommands.includes(record.command) && !/^(?:sh|bash|zsh|fish|dash|cmd|powershell|pwsh)$/iu.test(record.command)) {
      issues.push({ code: "POLICY_DENIED", path: `${command.path}.command`, message: "Command is not in the policy allowlist" });
    }
    if (Array.isArray(record.args)) record.args.forEach((arg, index) => {
      if (typeof arg === "string" && (/[;&|<>`$\u0000\n\r]/u.test(arg) || /^(?:-c|--command|-e|--eval|--exec|--execute|--shell|--require|-r|--loader|--inspect|--inspect-brk)$/u.test(arg))) {
        issues.push({ code: "UNSAFE_COMMAND", path: `${command.path}.args[${index}]`, message: "Argument contains forbidden execution syntax" });
      }
    });
  }
  const sources = input.logSources;
  if (Array.isArray(sources)) sources.forEach((source, index) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) return;
    const record = source as Record<string, unknown>;
    if (record.type !== "log" && record.type !== "application-log" && record.type !== "stack-trace") issues.push({ code: "UNSUPPORTED_LOG_SOURCE", path: `$.logSources[${index}].type`, message: "Unsupported log source type" });
    if (typeof record.locator === "string" && (record.locator.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(record.locator) || record.locator.includes(":") || record.locator.split(/[\\/]/u).includes("..") || record.locator.split(/[\\/]/u).includes(""))) issues.push({ code: "UNSAFE_LOCATOR", path: `$.logSources[${index}].locator`, message: "Locator must be a safe relative path" });
  });
  return issues;
}

export function intakeIncidentManifest(input: unknown, store: EvidenceStore, options: IntakeOptions = {}): IntakeResult {
  if (options.authorized === false) throw new ManifestValidationError([{ code: "AUTHORIZATION_DENIED", path: "$", message: "Caller is not authorized" }], 403);
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(input) ?? "", "utf8"); } catch { bytes = MAX_MANIFEST_BYTES + 1; }
  if (bytes > MAX_MANIFEST_BYTES) throw new ManifestValidationError([{ code: "MANIFEST_TOO_LARGE", path: "$", message: `Manifest exceeds ${MAX_MANIFEST_BYTES} bytes` }], 413);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ManifestValidationError([{ code: "MALFORMED_MANIFEST", path: "$", message: "Manifest must be a JSON object" }]);
  const secrets: IntakeError[] = [];
  scanSecrets(input, "$", secrets);
  if (secrets.length > 0) throw new ManifestValidationError(secrets);
  const policyIssues = policyAndExecutionIssues(input as Record<string, unknown>);
  if (policyIssues.length > 0) throw new ManifestValidationError(policyIssues, policyIssues.some((issue) => issue.code === "POLICY_DENIED") ? 403 : 400);
  const normalizedInput = normalizeInput(input as Record<string, unknown>);
  const withoutHash = { ...normalizedInput };
  delete withoutHash.contentHash;
  const contentHash = hash(withoutHash);
  const candidate = { ...withoutHash, contentHash };
  const validated = validateIncidentManifest(candidate);
  if (!validated.ok) throw new ManifestValidationError(mapValidationIssues(validated.issues));
  const manifest = validated.value;
  const evidencePayload: Omit<EvidenceItem, "contentHash"> = {
    schemaVersion: 1,
    kind: "EvidenceItem",
    id: `manifest-${contentHash.slice(7)}`,
    incidentId: manifest.incidentId,
    correlationId: manifest.correlationId,
    createdAt: manifest.createdAt,
    capturedAt: manifest.createdAt,
    content: manifest as unknown as JsonValue,
    source: { type: "incident-manifest", locator: `manifest:${manifest.id}` },
    redaction: { status: "not-required" },
    provenance: { actor: options.actor ?? "incident-intake", tool: "rift-api", sourceHash: contentHash },
  };
  const evidence = { ...evidencePayload, contentHash: hash(evidencePayload) } as EvidenceItem;
  return { manifest, manifestHash: contentHash, evidence: store.get(evidence.id) ?? store.append(evidence) };
}
