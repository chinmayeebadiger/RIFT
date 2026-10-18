import {
  CONTRACT_SCHEMA_VERSION,
  type AuditEvent,
  type AuditEventId,
  type CommandSpec,
  type CorrelationId,
  type EvidenceId,
  type EvidenceItem,
  type IncidentId,
  type IncidentManifest,
  type JsonValue,
  type ManifestId,
  type Provenance,
  type Sha256Hash,
  type Timestamp,
} from "./contracts.js";

export const MAX_ID_LENGTH = 128;
export const MAX_STRING_LENGTH = 512;
export const MAX_JSON_DEPTH = 16;
export const MAX_JSON_KEYS = 128;
export const MAX_ARRAY_LENGTH = 128;
export const MAX_COMMAND_ARGUMENTS = 64;
export const MAX_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_EVIDENCE_BYTES = 100 * 1_048_576;
export const MAX_CONTENT_BYTES = 1_048_576;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/u;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^(?:[0-9a-f]{7,40}|[0-9a-f]{64})$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const PATH_SEPARATOR_PATTERN = /[\\]/u;
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export interface ValidationIssue {
  readonly path: string;
  readonly code: string;
}

export type ValidationResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

type UnknownRecord = Record<string, unknown>;

function success<Value>(value: Value): ValidationResult<Value> {
  return { ok: true, value };
}

function failure<Value>(issues: readonly ValidationIssue[]): ValidationResult<Value> {
  return { ok: false, issues };
}

function addIssue(issues: ValidationIssue[], path: string, code: string): void {
  issues.push({ path, code });
}

function isRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value: unknown, path: string, issues: ValidationIssue[]): value is UnknownRecord {
  if (!isRecord(value)) {
    addIssue(issues, path, "invalid_type");
    return false;
  }
  return true;
}

function hasOwn(value: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function rejectUnknownKeys(
  value: UnknownRecord,
  allowedKeys: readonly string[],
  path: string,
  issues: ValidationIssue[],
): void {
  const allowed = new Set(allowedKeys);
  Object.keys(value)
    .filter((key) => !allowed.has(key))
    .sort()
    .forEach((key) => addIssue(issues, `${path}.${key}`, "unknown_key"));
}

function stringValue(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  options: { readonly maxLength: number; readonly nonEmpty?: boolean; readonly noControl?: boolean },
): value is string {
  if (typeof value !== "string") {
    addIssue(issues, path, "invalid_type");
    return false;
  }
  if (options.nonEmpty && value.length === 0) addIssue(issues, path, "empty_string");
  if (value.length > options.maxLength) addIssue(issues, path, "too_long");
  if (options.noControl && CONTROL_CHARACTER_PATTERN.test(value)) {
    addIssue(issues, path, "control_character");
  }
  return true;
}

function boundedString(value: unknown, path: string, issues: ValidationIssue[]): value is string {
  return stringValue(value, path, issues, {
    maxLength: MAX_STRING_LENGTH,
    nonEmpty: true,
    noControl: true,
  });
}

function enumValue<Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  path: string,
  issues: ValidationIssue[],
): value is Value {
  if (typeof value !== "string" || !allowed.includes(value as Value)) {
    addIssue(issues, path, "invalid_value");
    return false;
  }
  return true;
}

function required(value: UnknownRecord, key: string, path: string, issues: ValidationIssue[]): unknown {
  if (!hasOwn(value, key)) addIssue(issues, `${path}.${key}`, "missing");
  return value[key];
}

function idValue(value: unknown, path: string, issues: ValidationIssue[]): value is string {
  if (typeof value !== "string" || value.length > MAX_ID_LENGTH || !ID_PATTERN.test(value)) {
    addIssue(issues, path, "invalid_id");
    return false;
  }
  return true;
}

function timestampValue(value: unknown, path: string, issues: ValidationIssue[]): value is Timestamp {
  if (typeof value !== "string") {
    addIssue(issues, path, "invalid_timestamp");
    return false;
  }
  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match) {
    addIssue(issues, path, "invalid_timestamp");
    return false;
  }

  const [, year, month, day, hour, minute, second, milliseconds] = match;
  const date = new Date(value);
  const valid =
    !Number.isNaN(date.getTime()) &&
    date.toISOString() === value &&
    Number(month) >= 1 &&
    Number(month) <= 12 &&
    Number(day) >= 1 &&
    Number(day) <= 31 &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second) <= 59 &&
    Number(milliseconds) <= 999;
  if (!valid) addIssue(issues, path, "invalid_timestamp");
  return valid;
}

function hashValue(value: unknown, path: string, issues: ValidationIssue[]): value is Sha256Hash {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    addIssue(issues, path, "invalid_sha256_hash");
    return false;
  }
  return true;
}

function finiteInteger(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  minimum: number,
  maximum: number,
): value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    addIssue(issues, path, "invalid_integer");
    return false;
  }
  return true;
}

function arrayValue(value: unknown, path: string, issues: ValidationIssue[]): value is readonly unknown[] {
  if (!Array.isArray(value)) {
    addIssue(issues, path, "invalid_type");
    return false;
  }
  if (value.length > MAX_ARRAY_LENGTH) addIssue(issues, path, "too_many_items");
  return true;
}

function relativePath(value: unknown, path: string, issues: ValidationIssue[]): value is string {
  if (!boundedString(value, path, issues)) return false;
  const parts = value.split("/");
  if (
    value.startsWith("/") ||
    PATH_SEPARATOR_PATTERN.test(value) ||
    parts.includes("..") ||
    parts.includes("")
  ) {
    addIssue(issues, path, "invalid_relative_path");
  }
  return true;
}

function uniqueStrings(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  itemValidator: (item: unknown, path: string, issues: ValidationIssue[]) => boolean,
  requireAtLeastOne = false,
): value is readonly string[] {
  if (!arrayValue(value, path, issues)) return false;
  if (requireAtLeastOne && value.length === 0) addIssue(issues, path, "empty_array");
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (itemValidator(item, itemPath, issues) && typeof item === "string") {
      if (seen.has(item)) addIssue(issues, itemPath, "duplicate_value");
      seen.add(item);
    }
  });
  return true;
}

function validateJsonValue(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  depth = 0,
): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    if (typeof value === "string" && CONTROL_CHARACTER_PATTERN.test(value)) {
      addIssue(issues, path, "control_character");
    }
    return true;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) addIssue(issues, path, "non_finite_number");
    return Number.isFinite(value);
  }
  if (depth >= MAX_JSON_DEPTH) {
    addIssue(issues, path, "too_deep");
    return false;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) addIssue(issues, path, "too_many_items");
    value.forEach((item, index) => validateJsonValue(item, `${path}[${index}]`, issues, depth + 1));
    return true;
  }
  if (!isRecord(value)) {
    addIssue(issues, path, "invalid_json_value");
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_JSON_KEYS) addIssue(issues, path, "too_many_keys");
  keys.sort().forEach((key) => {
    if (CONTROL_CHARACTER_PATTERN.test(key)) addIssue(issues, `${path}.${key}`, "control_character");
    validateJsonValue(value[key], `${path}.${key}`, issues, depth + 1);
  });
  return true;
}

function validateVersionedBase(
  value: UnknownRecord,
  path: string,
  issues: ValidationIssue[],
): void {
  const schemaVersion = required(value, "schemaVersion", path, issues);
  if (schemaVersion !== CONTRACT_SCHEMA_VERSION) {
    addIssue(issues, `${path}.schemaVersion`, "unsupported_schema_version");
  }
  idValue(required(value, "id", path, issues), `${path}.id`, issues);
  idValue(required(value, "incidentId", path, issues), `${path}.incidentId`, issues);
  idValue(required(value, "correlationId", path, issues), `${path}.correlationId`, issues);
  timestampValue(required(value, "createdAt", path, issues), `${path}.createdAt`, issues);
  hashValue(required(value, "contentHash", path, issues), `${path}.contentHash`, issues);
}

function validateCommand(value: unknown, path: string, issues: ValidationIssue[]): value is CommandSpec {
  if (!requireRecord(value, path, issues)) return false;
  rejectUnknownKeys(value, ["command", "args", "workingDirectory", "environment"], path, issues);
  boundedString(required(value, "command", path, issues), `${path}.command`, issues);

  if (hasOwn(value, "args")) {
    if (arrayValue(value.args, `${path}.args`, issues)) {
      if (value.args.length > MAX_COMMAND_ARGUMENTS) addIssue(issues, `${path}.args`, "too_many_items");
      value.args.forEach((argument, index) =>
        boundedString(argument, `${path}.args[${index}]`, issues),
      );
    }
  }
  if (hasOwn(value, "workingDirectory")) {
    relativePath(value.workingDirectory, `${path}.workingDirectory`, issues);
  }
  if (hasOwn(value, "environment")) {
    if (requireRecord(value.environment, `${path}.environment`, issues)) {
      const keys = Object.keys(value.environment).sort();
      if (keys.length > MAX_JSON_KEYS) addIssue(issues, `${path}.environment`, "too_many_keys");
      keys.forEach((key) => {
        if (!ENVIRONMENT_KEY_PATTERN.test(key)) addIssue(issues, `${path}.environment.${key}`, "invalid_key");
        boundedString((value.environment as Record<string, unknown>)[key], `${path}.environment.${key}`, issues);
      });
    }
  }
  return true;
}

function validateManifest(value: UnknownRecord, issues: ValidationIssue[]): void {
  rejectUnknownKeys(
    value,
    [
      "kind",
      "schemaVersion",
      "id",
      "incidentId",
      "correlationId",
      "createdAt",
      "contentHash",
      "repositoryRevision",
      "allowedPaths",
      "logSources",
      "reproductionCommand",
      "testCommands",
      "timeWindow",
      "policy",
    ],
    "$",
    issues,
  );
  enumValue(value.kind, ["IncidentManifest"], "$.kind", issues);
  validateVersionedBase(value, "$", issues);

  const repositoryRevision = required(value, "repositoryRevision", "$", issues);
  if (!requireRecord(repositoryRevision, "$.repositoryRevision", issues)) {
    // The object type issue is sufficient; dependent fields are not inferred.
  } else {
    rejectUnknownKeys(repositoryRevision, ["repository", "revision"], "$.repositoryRevision", issues);
    boundedString(required(repositoryRevision, "repository", "$.repositoryRevision", issues), "$.repositoryRevision.repository", issues);
    const revision = required(repositoryRevision, "revision", "$.repositoryRevision", issues);
    if (typeof revision !== "string" || !REVISION_PATTERN.test(revision)) {
      addIssue(issues, "$.repositoryRevision.revision", "invalid_repository_revision");
    }
  }

  uniqueStrings(value.allowedPaths, "$.allowedPaths", issues, relativePath, true);
  if (arrayValue(value.logSources, "$.logSources", issues)) {
    if (value.logSources.length === 0) addIssue(issues, "$.logSources", "empty_array");
    const sourceIds = new Set<string>();
    value.logSources.forEach((source, index) => {
      const sourcePath = `$.logSources[${index}]`;
      if (!requireRecord(source, sourcePath, issues)) return;
      rejectUnknownKeys(source, ["id", "type", "locator", "contentHash"], sourcePath, issues);
      const id = required(source, "id", sourcePath, issues);
      if (boundedString(id, `${sourcePath}.id`, issues) && typeof id === "string") {
        if (sourceIds.has(id)) addIssue(issues, `${sourcePath}.id`, "duplicate_value");
        sourceIds.add(id);
      }
      boundedString(required(source, "type", sourcePath, issues), `${sourcePath}.type`, issues);
      boundedString(required(source, "locator", sourcePath, issues), `${sourcePath}.locator`, issues);
      if (hasOwn(source, "contentHash")) hashValue(source.contentHash, `${sourcePath}.contentHash`, issues);
    });
  }

  validateCommand(required(value, "reproductionCommand", "$", issues), "$.reproductionCommand", issues);
  if (arrayValue(value.testCommands, "$.testCommands", issues)) {
    value.testCommands.forEach((command, index) => validateCommand(command, `$.testCommands[${index}]`, issues));
  } else if (!hasOwn(value, "testCommands")) {
    addIssue(issues, "$.testCommands", "missing");
  }

  const timeWindow = required(value, "timeWindow", "$", issues);
  if (!requireRecord(timeWindow, "$.timeWindow", issues)) {
    // The object type issue is sufficient.
  } else {
    rejectUnknownKeys(timeWindow, ["start", "end"], "$.timeWindow", issues);
    const start = required(timeWindow, "start", "$.timeWindow", issues);
    const end = required(timeWindow, "end", "$.timeWindow", issues);
    const startValid = timestampValue(start, "$.timeWindow.start", issues);
    const endValid = timestampValue(end, "$.timeWindow.end", issues);
    if (startValid && endValid && start > end) addIssue(issues, "$.timeWindow", "invalid_order");
  }

  const policy = required(value, "policy", "$", issues);
  if (!requireRecord(policy, "$.policy", issues)) return;
  rejectUnknownKeys(policy, ["networkAccess", "allowedCommands", "maxEvidenceBytes", "redactSecrets"], "$.policy", issues);
  if (hasOwn(policy, "networkAccess")) {
    enumValue(policy.networkAccess, ["disabled", "allowlisted"], "$.policy.networkAccess", issues);
  }
  if (hasOwn(policy, "allowedCommands")) {
    uniqueStrings(policy.allowedCommands, "$.policy.allowedCommands", issues, boundedString);
  }
  if (hasOwn(policy, "maxEvidenceBytes")) {
    finiteInteger(policy.maxEvidenceBytes, "$.policy.maxEvidenceBytes", issues, 1, MAX_EVIDENCE_BYTES);
  }
  if (hasOwn(policy, "redactSecrets") && typeof policy.redactSecrets !== "boolean") {
    addIssue(issues, "$.policy.redactSecrets", "invalid_type");
  }
}

function validateProvenanceValue(value: unknown, path: string, issues: ValidationIssue[]): value is Provenance {
  if (!requireRecord(value, path, issues)) return false;
  rejectUnknownKeys(value, ["actor", "tool", "sourceHash", "metadata"], path, issues);
  boundedString(required(value, "actor", path, issues), `${path}.actor`, issues);
  if (hasOwn(value, "tool")) boundedString(value.tool, `${path}.tool`, issues);
  if (hasOwn(value, "sourceHash")) hashValue(value.sourceHash, `${path}.sourceHash`, issues);
  if (hasOwn(value, "metadata")) {
    if (!requireRecord(value.metadata, `${path}.metadata`, issues)) return true;
    const keys = Object.keys(value.metadata).sort();
    if (keys.length > MAX_JSON_KEYS) addIssue(issues, `${path}.metadata`, "too_many_keys");
    keys.forEach((key) => validateJsonValue((value.metadata as Record<string, unknown>)[key], `${path}.metadata.${key}`, issues));
  }
  return true;
}

function validateEvidence(value: UnknownRecord, issues: ValidationIssue[]): void {
  rejectUnknownKeys(
    value,
    [
      "kind",
      "schemaVersion",
      "id",
      "incidentId",
      "correlationId",
      "createdAt",
      "contentHash",
      "content",
      "source",
      "capturedAt",
      "redaction",
      "provenance",
    ],
    "$",
    issues,
  );
  enumValue(value.kind, ["EvidenceItem"], "$.kind", issues);
  validateVersionedBase(value, "$", issues);
  const content = required(value, "content", "$", issues);
  validateJsonValue(content, "$.content", issues);
  try {
    if (Buffer.byteLength(JSON.stringify(content) ?? "", "utf8") > MAX_CONTENT_BYTES) {
      addIssue(issues, "$.content", "too_large");
    }
  } catch {
    addIssue(issues, "$.content", "invalid_json_value");
  }

  const source = required(value, "source", "$", issues);
  if (requireRecord(source, "$.source", issues)) {
    rejectUnknownKeys(source, ["type", "locator"], "$.source", issues);
    boundedString(required(source, "type", "$.source", issues), "$.source.type", issues);
    boundedString(required(source, "locator", "$.source", issues), "$.source.locator", issues);
  }
  timestampValue(required(value, "capturedAt", "$", issues), "$.capturedAt", issues);

  const redaction = required(value, "redaction", "$", issues);
  if (requireRecord(redaction, "$.redaction", issues)) {
    rejectUnknownKeys(redaction, ["status", "rules"], "$.redaction", issues);
    enumValue(redaction.status, ["not-required", "redacted", "pending"], "$.redaction.status", issues);
    if (hasOwn(redaction, "rules")) uniqueStrings(redaction.rules, "$.redaction.rules", issues, boundedString);
  }
  validateProvenanceValue(required(value, "provenance", "$", issues), "$.provenance", issues);
}

function hashArray(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!arrayValue(value, path, issues)) return;
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (hashValue(item, itemPath, issues) && typeof item === "string") {
      if (seen.has(item)) addIssue(issues, itemPath, "duplicate_value");
      seen.add(item);
    }
  });
}

function validateAudit(value: UnknownRecord, issues: ValidationIssue[]): void {
  rejectUnknownKeys(
    value,
    [
      "kind",
      "schemaVersion",
      "id",
      "incidentId",
      "correlationId",
      "createdAt",
      "contentHash",
      "occurredAt",
      "actor",
      "action",
      "policyDecision",
      "result",
      "inputHashes",
      "outputHashes",
      "failure",
    ],
    "$",
    issues,
  );
  enumValue(value.kind, ["AuditEvent"], "$.kind", issues);
  validateVersionedBase(value, "$", issues);
  timestampValue(required(value, "occurredAt", "$", issues), "$.occurredAt", issues);

  const actor = required(value, "actor", "$", issues);
  if (requireRecord(actor, "$.actor", issues)) {
    rejectUnknownKeys(actor, ["kind", "id"], "$.actor", issues);
    enumValue(actor.kind, ["system", "human", "worker", "model"], "$.actor.kind", issues);
    boundedString(required(actor, "id", "$.actor", issues), "$.actor.id", issues);
  }
  enumValue(
    value.action,
    ["intake.validate", "evidence.import", "policy.evaluate", "model.call", "sandbox.create", "external.action"],
    "$.action",
    issues,
  );

  const policyDecision = required(value, "policyDecision", "$", issues);
  if (requireRecord(policyDecision, "$.policyDecision", issues)) {
    rejectUnknownKeys(policyDecision, ["outcome", "policyId", "reasonCode"], "$.policyDecision", issues);
    enumValue(policyDecision.outcome, ["allowed", "denied"], "$.policyDecision.outcome", issues);
    boundedString(required(policyDecision, "policyId", "$.policyDecision", issues), "$.policyDecision.policyId", issues);
    boundedString(required(policyDecision, "reasonCode", "$.policyDecision", issues), "$.policyDecision.reasonCode", issues);
  }

  const result = value.result;
  const validResult = enumValue(result, ["succeeded", "failed", "denied"], "$.result", issues);
  hashArray(required(value, "inputHashes", "$", issues), "$.inputHashes", issues);
  hashArray(required(value, "outputHashes", "$", issues), "$.outputHashes", issues);

  const hasFailure = hasOwn(value, "failure");
  if (hasFailure) {
    if (requireRecord(value.failure, "$.failure", issues)) {
      rejectUnknownKeys(value.failure, ["code"], "$.failure", issues);
      boundedString(required(value.failure, "code", "$.failure", issues), "$.failure.code", issues);
    }
  }

  if (validResult && result === "succeeded" && hasFailure) addIssue(issues, "$.failure", "not_allowed");
  if (validResult && result === "failed" && !hasFailure) addIssue(issues, "$.failure", "missing");
  if (validResult && result === "denied") {
    if (isRecord(policyDecision) && policyDecision.outcome !== "denied") {
      addIssue(issues, "$.policyDecision.outcome", "must_be_denied");
    }
    if (!hasFailure) addIssue(issues, "$.failure", "missing");
  }
  if (
    validResult &&
    result !== "denied" &&
    isRecord(policyDecision) &&
    policyDecision.outcome === "denied"
  ) {
    addIssue(issues, "$.policyDecision.outcome", "incompatible_with_result");
  }
}

function validateContract<T>(value: unknown, validator: (record: UnknownRecord, issues: ValidationIssue[]) => void): ValidationResult<T> {
  const issues: ValidationIssue[] = [];
  if (!requireRecord(value, "$", issues)) return failure(issues);
  validator(value, issues);
  return issues.length === 0 ? success(value as unknown as T) : failure(issues);
}

export function validateIncidentId(value: unknown): ValidationResult<IncidentId> {
  const issues: ValidationIssue[] = [];
  idValue(value, "$", issues);
  return issues.length === 0 ? success(value as IncidentId) : failure(issues);
}

export function validateManifestId(value: unknown): ValidationResult<ManifestId> {
  const issues: ValidationIssue[] = [];
  idValue(value, "$", issues);
  return issues.length === 0 ? success(value as ManifestId) : failure(issues);
}

export function validateEvidenceId(value: unknown): ValidationResult<EvidenceId> {
  const issues: ValidationIssue[] = [];
  idValue(value, "$", issues);
  return issues.length === 0 ? success(value as EvidenceId) : failure(issues);
}

export function validateAuditEventId(value: unknown): ValidationResult<AuditEventId> {
  const issues: ValidationIssue[] = [];
  idValue(value, "$", issues);
  return issues.length === 0 ? success(value as AuditEventId) : failure(issues);
}

export function validateCorrelationId(value: unknown): ValidationResult<CorrelationId> {
  const issues: ValidationIssue[] = [];
  idValue(value, "$", issues);
  return issues.length === 0 ? success(value as CorrelationId) : failure(issues);
}

export function validateTimestamp(value: unknown): ValidationResult<Timestamp> {
  const issues: ValidationIssue[] = [];
  timestampValue(value, "$", issues);
  return issues.length === 0 ? success(value as Timestamp) : failure(issues);
}

export function validateSha256Hash(value: unknown): ValidationResult<Sha256Hash> {
  const issues: ValidationIssue[] = [];
  hashValue(value, "$", issues);
  return issues.length === 0 ? success(value as Sha256Hash) : failure(issues);
}

export function validateProvenance(value: unknown): ValidationResult<Provenance> {
  const issues: ValidationIssue[] = [];
  validateProvenanceValue(value, "$", issues);
  return issues.length === 0 ? success(value as Provenance) : failure(issues);
}

export function validateIncidentManifest(value: unknown): ValidationResult<IncidentManifest> {
  return validateContract<IncidentManifest>(value, validateManifest);
}

export function validateEvidenceItem(value: unknown): ValidationResult<EvidenceItem> {
  return validateContract<EvidenceItem>(value, validateEvidence);
}

export function validateAuditEvent(value: unknown): ValidationResult<AuditEvent> {
  return validateContract<AuditEvent>(value, validateAudit);
}

export function isIncidentId(value: unknown): value is IncidentId {
  return validateIncidentId(value).ok;
}

export function isManifestId(value: unknown): value is ManifestId {
  return validateManifestId(value).ok;
}

export function isEvidenceId(value: unknown): value is EvidenceId {
  return validateEvidenceId(value).ok;
}

export function isAuditEventId(value: unknown): value is AuditEventId {
  return validateAuditEventId(value).ok;
}

export function isCorrelationId(value: unknown): value is CorrelationId {
  return validateCorrelationId(value).ok;
}

export function isTimestamp(value: unknown): value is Timestamp {
  return validateTimestamp(value).ok;
}

export function isSha256Hash(value: unknown): value is Sha256Hash {
  return validateSha256Hash(value).ok;
}
