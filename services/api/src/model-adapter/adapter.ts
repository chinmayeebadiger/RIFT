import {
  validateCandidatePatch,
  validateCorrelationId,
  validateIncidentId,
  validateSha256Hash,
  validateTimestamp,
} from "@rift/core";
import type { CandidatePatch, JsonValue } from "@rift/core";
import { canonicalJson, sha256 } from "../domain/hashing.js";
import type {
  CandidatePatchAdapter,
  CandidatePatchModelInput,
  CandidatePatchPolicy,
  CandidatePatchProvider,
  CandidatePatchRequest,
  ModelAdapterFailureIssue,
  ModelAdapterOptions,
} from "./types.js";
import { ModelAdapterError } from "./types.js";

const REVISION_PATTERN = /^(?:[0-9a-f]{7,40}|[0-9a-f]{64})$/u;
const PATH_PATTERN = /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*(?:^|\/)$)[^\u0000-\u001f\u007f]+$/u;
const SECRET_PATTERN = /-----BEGIN [^-]*PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:ghp|gho|ghs|xox[baprs])[-_A-Za-z0-9]{12,}\b|\bBearer\s+\S+|\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|token|password|passwd|secret)\s*[:=]\s*\S+/iu;
const SENSITIVE_KEY_PATTERN = /(?:api[_-]?key|access[_-]?token|client[_-]?secret|credential|password|passwd|private[_-]?key|secret|token)/iu;
const TOOL_OR_COMMAND_PATTERN = /\b(?:tool_calls?|function_call|execute_command|shell_command|curl|wget|bash|zsh|fish|powershell|pwsh|node|npm|pnpm|yarn|python|git)\b|(?:^|[\n|;&])\s*(?:\$|>)/imu;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function issue(path: string, code: string): ModelAdapterFailureIssue {
  return { path, code };
}

function failRequest(message: string, issues: readonly ModelAdapterFailureIssue[] = []): never {
  throw new ModelAdapterError("INVALID_REQUEST", message, issues);
}

function validatePath(path: unknown, field: string): path is string {
  if (typeof path !== "string" || !PATH_PATTERN.test(path)) failRequest(`Invalid relative path at ${field}`, [issue(field, "invalid_relative_path")]);
  return true;
}

function validateRevision(value: unknown, field: string): value is { readonly repository: string; readonly revision: string } {
  if (!isRecord(value) || typeof value.repository !== "string" || value.repository.length === 0 || typeof value.revision !== "string" || !REVISION_PATTERN.test(value.revision)) {
    failRequest(`Invalid repository revision at ${field}`, [issue(field, "invalid_revision")]);
  }
  return true;
}

function scanSecrets(value: unknown, path = "$", found: ModelAdapterFailureIssue[] = []): ModelAdapterFailureIssue[] {
  if (typeof value === "string") {
    if (SECRET_PATTERN.test(value)) found.push(issue(path, "secret_input"));
    return found;
  }
  if (value === null || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanSecrets(item, `${path}[${index}]`, found));
    return found;
  }
  Object.entries(value).forEach(([key, item]) => {
    if (SENSITIVE_KEY_PATTERN.test(key) && typeof item === "string" && item.length > 0) found.push(issue(`${path}.${key}`, "secret_input"));
    scanSecrets(item, `${path}.${key}`, found);
  });
  return found;
}

function validateModelInput(input: unknown): asserts input is CandidatePatchModelInput {
  if (!isRecord(input)) failRequest("Model input must be an object", [issue("$.modelInput", "invalid_type")]);
  const unknownInputKeys = Object.keys(input).filter((key) => !["schemaVersion", "incidentId", "correlationId", "createdAt", "repositoryRevision", "hypothesisId", "hypothesisSummary", "targetPath", "inputHash"].includes(key));
  if (unknownInputKeys.length > 0) failRequest("Model input contains unknown fields", unknownInputKeys.map((key) => issue(`$.modelInput.${key}`, "unknown_key")));
  if (input.schemaVersion !== 1) failRequest("Model input has an unsupported schema version", [issue("$.modelInput.schemaVersion", "unsupported_schema_version")]);
  if (!validateIncidentId(input.incidentId).ok) failRequest("Model input has an invalid incident ID", [issue("$.modelInput.incidentId", "invalid_id")]);
  if (!validateCorrelationId(input.correlationId).ok) failRequest("Model input has an invalid correlation ID", [issue("$.modelInput.correlationId", "invalid_id")]);
  if (!validateTimestamp(input.createdAt).ok) failRequest("Model input has an invalid timestamp", [issue("$.modelInput.createdAt", "invalid_timestamp")]);
  validateRevision(input.repositoryRevision, "$.modelInput.repositoryRevision");
  if (typeof input.hypothesisId !== "string" || input.hypothesisId.length === 0) failRequest("Model input has an invalid hypothesis ID", [issue("$.modelInput.hypothesisId", "invalid_id")]);
  if (typeof input.hypothesisSummary !== "string" || input.hypothesisSummary.length === 0) failRequest("Model input has an invalid hypothesis summary", [issue("$.modelInput.hypothesisSummary", "invalid_value")]);
  validatePath(input.targetPath, "$.modelInput.targetPath");
  if (!validateSha256Hash(input.inputHash).ok) failRequest("Model input has an invalid input hash", [issue("$.modelInput.inputHash", "invalid_sha256_hash")]);
  const secrets = scanSecrets(input, "$.modelInput");
  if (secrets.length > 0) throw new ModelAdapterError("SECRET_INPUT", "Model input contains secret-bearing data", secrets);
  const { inputHash, ...withoutInputHash } = input;
  if (inputHash !== sha256(withoutInputHash as unknown as JsonValue)) failRequest("Model input hash does not match its contents", [issue("$.modelInput.inputHash", "content_hash_mismatch")]);
}

function validatePolicy(policy: unknown): asserts policy is CandidatePatchPolicy {
  if (!isRecord(policy)) failRequest("Candidate patch policy must be an object", [issue("$.policy", "invalid_type")]);
  if (policy.authorized !== true) throw new ModelAdapterError("POLICY_DENIED", "Model call is not authorized", [issue("$.policy.authorized", "denied")]);
  if (!validateIncidentId(policy.incidentId).ok) failRequest("Policy has an invalid incident ID", [issue("$.policy.incidentId", "invalid_id")]);
  validateRevision(policy.repositoryRevision, "$.policy.repositoryRevision");
  if (typeof policy.hypothesisId !== "string" || policy.hypothesisId.length === 0) failRequest("Policy has an invalid hypothesis ID", [issue("$.policy.hypothesisId", "invalid_id")]);
  if (!Array.isArray(policy.allowedPaths) || policy.allowedPaths.length === 0) failRequest("Policy must allow at least one path", [issue("$.policy.allowedPaths", "empty_array")]);
  policy.allowedPaths.forEach((path, index) => validatePath(path, `$.policy.allowedPaths[${index}]`));
  if (policy.actor !== "fake-model" && policy.actor !== "gpt-6-astra") failRequest("Policy has an invalid model actor", [issue("$.policy.actor", "invalid_value")]);
  const maxDiffBytes = policy.maxDiffBytes;
  const maxTouchedPaths = policy.maxTouchedPaths;
  if (maxDiffBytes !== undefined && (typeof maxDiffBytes !== "number" || !Number.isSafeInteger(maxDiffBytes) || maxDiffBytes < 1 || maxDiffBytes > 1_048_576)) failRequest("Policy has an invalid diff limit", [issue("$.policy.maxDiffBytes", "invalid_integer")]);
  if (maxTouchedPaths !== undefined && (typeof maxTouchedPaths !== "number" || !Number.isSafeInteger(maxTouchedPaths) || maxTouchedPaths < 1 || maxTouchedPaths > 128)) failRequest("Policy has an invalid path limit", [issue("$.policy.maxTouchedPaths", "invalid_integer")]);
}

function sameRevision(left: CandidatePatch["baseRevision"], right: CandidatePatchPolicy["repositoryRevision"]): boolean {
  return left.repository === right.repository && left.revision === right.revision;
}

function isAllowedPath(path: string, allowedPaths: readonly string[]): boolean {
  return allowedPaths.some((allowed) => path === allowed || path.startsWith(`${allowed}/`));
}

function proposalPolicyIssues(candidate: CandidatePatch, policy: CandidatePatchPolicy): ModelAdapterFailureIssue[] {
  const issues: ModelAdapterFailureIssue[] = [];
  if (candidate.incidentId !== policy.incidentId) issues.push(issue("$.incidentId", "incident_mismatch"));
  if (!sameRevision(candidate.baseRevision, policy.repositoryRevision)) issues.push(issue("$.baseRevision", "revision_mismatch"));
  if (candidate.sourceHypothesisId !== policy.hypothesisId) issues.push(issue("$.sourceHypothesisId", "hypothesis_mismatch"));
  if (candidate.generatedBy.actor !== policy.actor) issues.push(issue("$.generatedBy.actor", "actor_not_authorized"));
  if (policy.maxDiffBytes !== undefined && Buffer.byteLength(candidate.diff, "utf8") > policy.maxDiffBytes) issues.push(issue("$.diff", "diff_too_large"));
  if (policy.maxTouchedPaths !== undefined && candidate.touchedPaths.length > policy.maxTouchedPaths) issues.push(issue("$.touchedPaths", "too_many_paths"));
  if (candidate.touchedPaths.some((path) => !isAllowedPath(path, policy.allowedPaths))) issues.push(issue("$.touchedPaths", "path_not_authorized"));
  const diffPaths = [...candidate.diff.matchAll(/^(?:diff --git|---|\+\+\+)\s+(?:a\/|b\/)?([^\s]+)(?:\s+.*)?$/gmu)].map((match) => match[1]);
  if (diffPaths.some((path) => !candidate.touchedPaths.includes(path) || !isAllowedPath(path, policy.allowedPaths))) issues.push(issue("$.diff", "diff_path_not_authorized"));
  if (!candidate.diff.startsWith("diff --git ") || !candidate.diff.includes("\n--- ") || !candidate.diff.includes("\n+++ ")) issues.push(issue("$.diff", "invalid_unified_diff"));
  const diffWithoutHeader = candidate.diff.replaceAll("diff --git", "");
  if (TOOL_OR_COMMAND_PATTERN.test(`${diffWithoutHeader}\n${candidate.rationale}\n${candidate.expectedInvariant}`)) issues.push(issue("$", "tool_or_command_proposal"));
  const secrets = scanSecrets(candidate);
  if (secrets.length > 0) issues.push(issue("$", "secret_output"));
  return issues;
}

function parseProviderOutput(output: unknown, maxOutputBytes: number): unknown {
  if (typeof output !== "string") throw new ModelAdapterError("MALFORMED_OUTPUT", "Provider output must be a JSON string", [issue("$", "invalid_type")]);
  if (Buffer.byteLength(output, "utf8") > maxOutputBytes) throw new ModelAdapterError("MALFORMED_OUTPUT", "Provider output exceeds the adapter limit", [issue("$", "too_large")]);
  try {
    return JSON.parse(output) as unknown;
  } catch {
    throw new ModelAdapterError("MALFORMED_OUTPUT", "Provider output is not valid JSON", [issue("$", "invalid_json")]);
  }
}

export class BoundedCandidatePatchAdapter implements CandidatePatchAdapter {
  private readonly defaultTimeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly maxOutputBytes: number;

  public constructor(private readonly provider: CandidatePatchProvider, options: ModelAdapterOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 1_000;
    this.maxTimeoutMs = options.maxTimeoutMs ?? 10_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
    if (!Number.isSafeInteger(this.defaultTimeoutMs) || this.defaultTimeoutMs < 1 || this.defaultTimeoutMs > this.maxTimeoutMs) throw new RangeError("Invalid default model timeout");
    if (!Number.isSafeInteger(this.maxTimeoutMs) || this.maxTimeoutMs < 1) throw new RangeError("Invalid maximum model timeout");
  }

  public async propose(request: CandidatePatchRequest): Promise<CandidatePatch> {
    if (!isRecord(request)) failRequest("Candidate patch request must be an object");
    validateModelInput(request.modelInput);
    validatePolicy(request.policy);
    if (request.modelInput.incidentId !== request.policy.incidentId) throw new ModelAdapterError("POLICY_DENIED", "Input incident does not match authorized incident", [issue("$.modelInput.incidentId", "incident_mismatch")]);
    if (!sameRevision(request.modelInput.repositoryRevision, request.policy.repositoryRevision)) throw new ModelAdapterError("POLICY_DENIED", "Input revision does not match authorized revision", [issue("$.modelInput.repositoryRevision", "revision_mismatch")]);
    if (request.modelInput.hypothesisId !== request.policy.hypothesisId) throw new ModelAdapterError("POLICY_DENIED", "Input hypothesis does not match authorized hypothesis", [issue("$.modelInput.hypothesisId", "hypothesis_mismatch")]);
    if (!isAllowedPath(request.modelInput.targetPath, request.policy.allowedPaths)) throw new ModelAdapterError("POLICY_DENIED", "Input target path is outside the authorized paths", [issue("$.modelInput.targetPath", "path_not_authorized")]);

    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > this.maxTimeoutMs) failRequest("Request timeout is outside the adapter bound", [issue("$.timeoutMs", "invalid_timeout")]);
    if (request.signal?.aborted) throw new ModelAdapterError("CANCELLED", "Model request was cancelled before provider execution");

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const onAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new ModelAdapterError("TIMEOUT", `Model provider exceeded ${timeoutMs}ms`));
        }, timeoutMs);
      });
      let raw: unknown;
      try {
        const providerPromise = Promise.resolve().then(() => {
          if (request.signal?.aborted) throw new ModelAdapterError("CANCELLED", "Model request was cancelled");
          return this.provider.generate(canonicalJson(request.modelInput as unknown as JsonValue), controller.signal);
        });
        const guardedProvider = providerPromise.then(
          (value) => {
            if (controller.signal.aborted) throw new ModelAdapterError(timedOut ? "TIMEOUT" : "CANCELLED", "Model provider completed after cancellation");
            return value;
          },
          (error) => {
            if (controller.signal.aborted) throw new ModelAdapterError(timedOut ? "TIMEOUT" : "CANCELLED", "Model provider failed after cancellation");
            throw error;
          },
        );
        raw = await Promise.race([guardedProvider, timeout]);
      } catch (error) {
        if (timedOut) throw error;
        if (request.signal?.aborted || controller.signal.aborted) throw new ModelAdapterError("CANCELLED", "Model request was cancelled");
        if (error instanceof ModelAdapterError) throw error;
        throw new ModelAdapterError("PROVIDER_ERROR", error instanceof Error ? error.message : "Model provider failed");
      }
      const parsed = parseProviderOutput(raw, this.maxOutputBytes);
      const validated = validateCandidatePatch(parsed);
      if (!validated.ok) throw new ModelAdapterError("SCHEMA_INVALID", "Provider proposal failed CandidatePatch validation", validated.issues);
      const { contentHash, ...withoutContentHash } = validated.value;
      const policyIssues = proposalPolicyIssues(validated.value, request.policy);
      if (contentHash !== sha256(withoutContentHash as unknown as JsonValue)) policyIssues.push(issue("$.contentHash", "content_hash_mismatch"));
      if (policyIssues.length > 0) throw new ModelAdapterError("OUTPUT_REJECTED", "Provider proposal failed independent policy checks", policyIssues);
      return validated.value;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }
}

export const ModelAdapter = BoundedCandidatePatchAdapter;
