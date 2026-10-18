import { CONTRACT_SCHEMA_VERSION } from "./contracts.js";

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
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/u;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^(?:[0-9a-f]{7,40}|[0-9a-f]{64})$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const PATH_SEPARATOR_PATTERN = /[\\]/u;
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const success = (value) => ({ ok: true, value });
const failure = (issues) => ({ ok: false, issues });
const issue = (issues, path, code) => issues.push({ path, code });
const isRecord = (value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function requireRecord(value, path, issues) {
  if (!isRecord(value)) {
    issue(issues, path, "invalid_type");
    return false;
  }
  return true;
}

function unknownKeys(value, allowed, path, issues) {
  const accepted = new Set(allowed);
  Object.keys(value).filter((key) => !accepted.has(key)).sort().forEach((key) => issue(issues, `${path}.${key}`, "unknown_key"));
}

function required(value, key, path, issues) {
  if (!hasOwn(value, key)) issue(issues, `${path}.${key}`, "missing");
  return value[key];
}

function stringValue(value, path, issues, { maxLength = MAX_STRING_LENGTH, nonEmpty = true, noControl = true } = {}) {
  if (typeof value !== "string") {
    issue(issues, path, "invalid_type");
    return false;
  }
  if (nonEmpty && value.length === 0) issue(issues, path, "empty_string");
  if (value.length > maxLength) issue(issues, path, "too_long");
  if (noControl && CONTROL_CHARACTER_PATTERN.test(value)) issue(issues, path, "control_character");
  return true;
}

function boundedString(value, path, issues) {
  return stringValue(value, path, issues);
}

function enumValue(value, allowed, path, issues) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    issue(issues, path, "invalid_value");
    return false;
  }
  return true;
}

function idValue(value, path, issues) {
  if (typeof value !== "string" || value.length > MAX_ID_LENGTH || !ID_PATTERN.test(value)) {
    issue(issues, path, "invalid_id");
    return false;
  }
  return true;
}

function timestampValue(value, path, issues) {
  if (typeof value !== "string") {
    issue(issues, path, "invalid_timestamp");
    return false;
  }
  const match = TIMESTAMP_PATTERN.exec(value);
  const date = match ? new Date(value) : null;
  const valid = Boolean(match && date && !Number.isNaN(date.getTime()) && date.toISOString() === value);
  if (!valid) issue(issues, path, "invalid_timestamp");
  return valid;
}

function hashValue(value, path, issues) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    issue(issues, path, "invalid_sha256_hash");
    return false;
  }
  return true;
}

function finiteInteger(value, path, issues, minimum, maximum) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    issue(issues, path, "invalid_integer");
    return false;
  }
  return true;
}

function arrayValue(value, path, issues) {
  if (!Array.isArray(value)) {
    issue(issues, path, "invalid_type");
    return false;
  }
  if (value.length > MAX_ARRAY_LENGTH) issue(issues, path, "too_many_items");
  return true;
}

function relativePath(value, path, issues) {
  if (!boundedString(value, path, issues)) return false;
  const parts = value.split("/");
  if (value.startsWith("/") || PATH_SEPARATOR_PATTERN.test(value) || parts.includes("..") || parts.includes("")) {
    issue(issues, path, "invalid_relative_path");
  }
  return true;
}

function uniqueStrings(value, path, issues, validator = boundedString, requireAtLeastOne = false) {
  if (!arrayValue(value, path, issues)) return false;
  if (requireAtLeastOne && value.length === 0) issue(issues, path, "empty_array");
  const seen = new Set();
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (validator(item, itemPath, issues) && typeof item === "string") {
      if (seen.has(item)) issue(issues, itemPath, "duplicate_value");
      seen.add(item);
    }
  });
  return true;
}

function validateJsonValue(value, path, issues, depth = 0) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    if (typeof value === "string" && CONTROL_CHARACTER_PATTERN.test(value)) issue(issues, path, "control_character");
    return true;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) issue(issues, path, "non_finite_number");
    return Number.isFinite(value);
  }
  if (depth >= MAX_JSON_DEPTH) {
    issue(issues, path, "too_deep");
    return false;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) issue(issues, path, "too_many_items");
    value.forEach((item, index) => validateJsonValue(item, `${path}[${index}]`, issues, depth + 1));
    return true;
  }
  if (!isRecord(value)) {
    issue(issues, path, "invalid_json_value");
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_JSON_KEYS) issue(issues, path, "too_many_keys");
  keys.sort().forEach((key) => {
    if (CONTROL_CHARACTER_PATTERN.test(key)) issue(issues, `${path}.${key}`, "control_character");
    validateJsonValue(value[key], `${path}.${key}`, issues, depth + 1);
  });
  return true;
}

function validateVersionedBase(value, path, issues) {
  if (required(value, "schemaVersion", path, issues) !== CONTRACT_SCHEMA_VERSION) issue(issues, `${path}.schemaVersion`, "unsupported_schema_version");
  idValue(required(value, "id", path, issues), `${path}.id`, issues);
  idValue(required(value, "incidentId", path, issues), `${path}.incidentId`, issues);
  idValue(required(value, "correlationId", path, issues), `${path}.correlationId`, issues);
  timestampValue(required(value, "createdAt", path, issues), `${path}.createdAt`, issues);
  hashValue(required(value, "contentHash", path, issues), `${path}.contentHash`, issues);
}

function validateCommand(value, path, issues) {
  if (!requireRecord(value, path, issues)) return false;
  unknownKeys(value, ["command", "args", "workingDirectory", "environment"], path, issues);
  boundedString(required(value, "command", path, issues), `${path}.command`, issues);
  if (hasOwn(value, "args") && arrayValue(value.args, `${path}.args`, issues)) {
    if (value.args.length > MAX_COMMAND_ARGUMENTS) issue(issues, `${path}.args`, "too_many_items");
    value.args.forEach((argument, index) => boundedString(argument, `${path}.args[${index}]`, issues));
  }
  if (hasOwn(value, "workingDirectory")) relativePath(value.workingDirectory, `${path}.workingDirectory`, issues);
  if (hasOwn(value, "environment") && requireRecord(value.environment, `${path}.environment`, issues)) {
    Object.keys(value.environment).sort().forEach((key) => {
      if (!ENVIRONMENT_KEY_PATTERN.test(key)) issue(issues, `${path}.environment.${key}`, "invalid_key");
      boundedString(value.environment[key], `${path}.environment.${key}`, issues);
    });
  }
  return true;
}

function validateManifest(value, issues) {
  unknownKeys(value, ["kind", "schemaVersion", "id", "incidentId", "correlationId", "createdAt", "contentHash", "repositoryRevision", "allowedPaths", "logSources", "reproductionCommand", "testCommands", "timeWindow", "policy"], "$", issues);
  enumValue(value.kind, ["IncidentManifest"], "$.kind", issues);
  validateVersionedBase(value, "$", issues);
  const repositoryRevision = required(value, "repositoryRevision", "$", issues);
  if (requireRecord(repositoryRevision, "$.repositoryRevision", issues)) {
    unknownKeys(repositoryRevision, ["repository", "revision"], "$.repositoryRevision", issues);
    boundedString(required(repositoryRevision, "repository", "$.repositoryRevision", issues), "$.repositoryRevision.repository", issues);
    const revision = required(repositoryRevision, "revision", "$.repositoryRevision", issues);
    if (typeof revision !== "string" || !REVISION_PATTERN.test(revision)) issue(issues, "$.repositoryRevision.revision", "invalid_repository_revision");
  }
  uniqueStrings(value.allowedPaths, "$.allowedPaths", issues, relativePath, true);
  if (arrayValue(value.logSources, "$.logSources", issues)) {
    if (value.logSources.length === 0) issue(issues, "$.logSources", "empty_array");
    const sourceIds = new Set();
    value.logSources.forEach((source, index) => {
      const path = `$.logSources[${index}]`;
      if (!requireRecord(source, path, issues)) return;
      unknownKeys(source, ["id", "type", "locator", "contentHash"], path, issues);
      const id = required(source, "id", path, issues);
      if (boundedString(id, `${path}.id`, issues) && typeof id === "string") {
        if (sourceIds.has(id)) issue(issues, `${path}.id`, "duplicate_value");
        sourceIds.add(id);
      }
      boundedString(required(source, "type", path, issues), `${path}.type`, issues);
      boundedString(required(source, "locator", path, issues), `${path}.locator`, issues);
      if (hasOwn(source, "contentHash")) hashValue(source.contentHash, `${path}.contentHash`, issues);
    });
  }
  validateCommand(required(value, "reproductionCommand", "$", issues), "$.reproductionCommand", issues);
  if (arrayValue(value.testCommands, "$.testCommands", issues)) value.testCommands.forEach((command, index) => validateCommand(command, `$.testCommands[${index}]`, issues));
  else if (!hasOwn(value, "testCommands")) issue(issues, "$.testCommands", "missing");
  const timeWindow = required(value, "timeWindow", "$", issues);
  if (requireRecord(timeWindow, "$.timeWindow", issues)) {
    unknownKeys(timeWindow, ["start", "end"], "$.timeWindow", issues);
    const start = required(timeWindow, "start", "$.timeWindow", issues);
    const end = required(timeWindow, "end", "$.timeWindow", issues);
    const startValid = timestampValue(start, "$.timeWindow.start", issues);
    const endValid = timestampValue(end, "$.timeWindow.end", issues);
    if (startValid && endValid && start > end) issue(issues, "$.timeWindow", "invalid_order");
  }
  const policy = required(value, "policy", "$", issues);
  if (!requireRecord(policy, "$.policy", issues)) return;
  unknownKeys(policy, ["networkAccess", "allowedCommands", "maxEvidenceBytes", "redactSecrets"], "$.policy", issues);
  if (hasOwn(policy, "networkAccess")) enumValue(policy.networkAccess, ["disabled", "allowlisted"], "$.policy.networkAccess", issues);
  if (hasOwn(policy, "allowedCommands")) uniqueStrings(policy.allowedCommands, "$.policy.allowedCommands", issues);
  if (hasOwn(policy, "maxEvidenceBytes")) finiteInteger(policy.maxEvidenceBytes, "$.policy.maxEvidenceBytes", issues, 1, MAX_EVIDENCE_BYTES);
  if (hasOwn(policy, "redactSecrets") && typeof policy.redactSecrets !== "boolean") issue(issues, "$.policy.redactSecrets", "invalid_type");
}

function validateProvenanceValue(value, path, issues) {
  if (!requireRecord(value, path, issues)) return false;
  unknownKeys(value, ["actor", "tool", "sourceHash", "metadata"], path, issues);
  boundedString(required(value, "actor", path, issues), `${path}.actor`, issues);
  if (hasOwn(value, "tool")) boundedString(value.tool, `${path}.tool`, issues);
  if (hasOwn(value, "sourceHash")) hashValue(value.sourceHash, `${path}.sourceHash`, issues);
  if (hasOwn(value, "metadata") && requireRecord(value.metadata, `${path}.metadata`, issues)) {
    Object.keys(value.metadata).sort().forEach((key) => validateJsonValue(value.metadata[key], `${path}.metadata.${key}`, issues));
  }
  return true;
}

function validateEvidence(value, issues) {
  unknownKeys(value, ["kind", "schemaVersion", "id", "incidentId", "correlationId", "createdAt", "contentHash", "content", "source", "capturedAt", "redaction", "provenance"], "$", issues);
  enumValue(value.kind, ["EvidenceItem"], "$.kind", issues);
  validateVersionedBase(value, "$", issues);
  const content = required(value, "content", "$", issues);
  validateJsonValue(content, "$.content", issues);
  try { if (Buffer.byteLength(JSON.stringify(content) ?? "", "utf8") > MAX_CONTENT_BYTES) issue(issues, "$.content", "too_large"); } catch { issue(issues, "$.content", "invalid_json_value"); }
  const source = required(value, "source", "$", issues);
  if (requireRecord(source, "$.source", issues)) {
    unknownKeys(source, ["type", "locator"], "$.source", issues);
    boundedString(required(source, "type", "$.source", issues), "$.source.type", issues);
    boundedString(required(source, "locator", "$.source", issues), "$.source.locator", issues);
  }
  timestampValue(required(value, "capturedAt", "$", issues), "$.capturedAt", issues);
  const redaction = required(value, "redaction", "$", issues);
  if (requireRecord(redaction, "$.redaction", issues)) {
    unknownKeys(redaction, ["status", "rules"], "$.redaction", issues);
    enumValue(redaction.status, ["not-required", "redacted", "pending"], "$.redaction.status", issues);
    if (hasOwn(redaction, "rules")) uniqueStrings(redaction.rules, "$.redaction.rules", issues);
  }
  validateProvenanceValue(required(value, "provenance", "$", issues), "$.provenance", issues);
}

function hashArray(value, path, issues) {
  if (!arrayValue(value, path, issues)) return;
  const seen = new Set();
  value.forEach((item, index) => {
    if (hashValue(item, `${path}[${index}]`, issues) && typeof item === "string") {
      if (seen.has(item)) issue(issues, `${path}[${index}]`, "duplicate_value");
      seen.add(item);
    }
  });
}

function validateAudit(value, issues) {
  unknownKeys(value, ["kind", "schemaVersion", "id", "incidentId", "correlationId", "createdAt", "contentHash", "occurredAt", "actor", "action", "policyDecision", "result", "inputHashes", "outputHashes", "failure"], "$", issues);
  enumValue(value.kind, ["AuditEvent"], "$.kind", issues);
  validateVersionedBase(value, "$", issues);
  timestampValue(required(value, "occurredAt", "$", issues), "$.occurredAt", issues);
  const actor = required(value, "actor", "$", issues);
  if (requireRecord(actor, "$.actor", issues)) {
    unknownKeys(actor, ["kind", "id"], "$.actor", issues);
    enumValue(actor.kind, ["system", "human", "worker", "model"], "$.actor.kind", issues);
    boundedString(required(actor, "id", "$.actor", issues), "$.actor.id", issues);
  }
  enumValue(value.action, ["intake.validate", "evidence.import", "policy.evaluate", "model.call", "sandbox.create", "external.action"], "$.action", issues);
  const policyDecision = required(value, "policyDecision", "$", issues);
  if (requireRecord(policyDecision, "$.policyDecision", issues)) {
    unknownKeys(policyDecision, ["outcome", "policyId", "reasonCode"], "$.policyDecision", issues);
    enumValue(policyDecision.outcome, ["allowed", "denied"], "$.policyDecision.outcome", issues);
    boundedString(required(policyDecision, "policyId", "$.policyDecision", issues), "$.policyDecision.policyId", issues);
    boundedString(required(policyDecision, "reasonCode", "$.policyDecision", issues), "$.policyDecision.reasonCode", issues);
  }
  const validResult = enumValue(value.result, ["succeeded", "failed", "denied"], "$.result", issues);
  hashArray(required(value, "inputHashes", "$", issues), "$.inputHashes", issues);
  hashArray(required(value, "outputHashes", "$", issues), "$.outputHashes", issues);
  const hasFailure = hasOwn(value, "failure");
  if (hasFailure && requireRecord(value.failure, "$.failure", issues)) {
    unknownKeys(value.failure, ["code"], "$.failure", issues);
    boundedString(required(value.failure, "code", "$.failure", issues), "$.failure.code", issues);
  }
  if (validResult && value.result === "succeeded" && hasFailure) issue(issues, "$.failure", "not_allowed");
  if (validResult && value.result === "failed" && !hasFailure) issue(issues, "$.failure", "missing");
  if (validResult && value.result === "denied") {
    if (isRecord(policyDecision) && policyDecision.outcome !== "denied") issue(issues, "$.policyDecision.outcome", "must_be_denied");
    if (!hasFailure) issue(issues, "$.failure", "missing");
  }
  if (validResult && value.result !== "denied" && isRecord(policyDecision) && policyDecision.outcome === "denied") issue(issues, "$.policyDecision.outcome", "incompatible_with_result");
}

function validateContract(value, validator) {
  const issues = [];
  if (!requireRecord(value, "$", issues)) return failure(issues);
  validator(value, issues);
  return issues.length === 0 ? success(value) : failure(issues);
}

function validateSimple(value, kind, keys, extra) {
  return validateContract(value, (record, issues) => {
    unknownKeys(record, ["kind", "schemaVersion", "id", "incidentId", "correlationId", "createdAt", "contentHash", ...keys], "$", issues);
    enumValue(record.kind, [kind], "$.kind", issues);
    validateVersionedBase(record, "$", issues);
    extra(record, issues);
  });
}

const idValidator = (value) => { const issues = []; idValue(value, "$", issues); return issues.length === 0 ? success(value) : failure(issues); };
export const validateIncidentId = idValidator;
export const validateManifestId = idValidator;
export const validateEvidenceId = idValidator;
export const validateHypothesisId = idValidator;
export const validateHypothesisSetId = idValidator;
export const validateCandidatePatchId = idValidator;
export const validateVerificationPlanId = idValidator;
export const validateVerificationResultId = idValidator;
export const validateRecoveryReportId = idValidator;
export const validateAuditEventId = idValidator;
export const validateCorrelationId = idValidator;
export const validateTimestamp = (value) => { const issues = []; timestampValue(value, "$", issues); return issues.length === 0 ? success(value) : failure(issues); };
export const validateSha256Hash = (value) => { const issues = []; hashValue(value, "$", issues); return issues.length === 0 ? success(value) : failure(issues); };
export const validateProvenance = (value) => { const issues = []; validateProvenanceValue(value, "$", issues); return issues.length === 0 ? success(value) : failure(issues); };
export const validateIncidentManifest = (value) => validateContract(value, validateManifest);
export const validateEvidenceItem = (value) => validateContract(value, validateEvidence);
export const validateAuditEvent = (value) => validateContract(value, validateAudit);

export const validateHypothesis = (value) => validateSimple(value, "Hypothesis", ["statement", "status", "confidence", "supportingEvidenceIds", "contradictingEvidenceIds", "assumptions", "nextCheck"], (record, issues) => {
  boundedString(record.statement, "$.statement", issues);
  enumValue(record.status, ["open", "confirmed", "rejected", "inconclusive"], "$.status", issues);
  if (typeof record.confidence !== "number" || !Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) issue(issues, "$.confidence", "invalid_number");
  uniqueStrings(record.supportingEvidenceIds, "$.supportingEvidenceIds", issues, idValue);
  uniqueStrings(record.contradictingEvidenceIds, "$.contradictingEvidenceIds", issues, idValue);
  uniqueStrings(record.assumptions, "$.assumptions", issues);
  boundedString(record.nextCheck, "$.nextCheck", issues);
});
export const validateHypothesisSet = (value) => validateSimple(value, "HypothesisSet", ["hypotheses", "rankingMethod"], (record, issues) => {
  if (arrayValue(record.hypotheses, "$.hypotheses", issues)) record.hypotheses.forEach((item, index) => { const result = validateHypothesis(item); if (!result.ok) result.issues.forEach((entry) => issue(issues, `$.hypotheses[${index}]${entry.path.slice(1)}`, entry.code)); });
  boundedString(record.rankingMethod, "$.rankingMethod", issues);
});
export const validateCandidatePatch = (value) => validateSimple(value, "CandidatePatch", ["sourceHypothesisId", "baseRevision", "diff", "touchedPaths", "rationale", "expectedInvariant", "generatedBy"], (record, issues) => {
  idValue(record.sourceHypothesisId, "$.sourceHypothesisId", issues);
  if (requireRecord(record.baseRevision, "$.baseRevision", issues)) { unknownKeys(record.baseRevision, ["repository", "revision"], "$.baseRevision", issues); boundedString(record.baseRevision.repository, "$.baseRevision.repository", issues); boundedString(record.baseRevision.revision, "$.baseRevision.revision", issues); }
  boundedString(record.diff, "$.diff", issues); uniqueStrings(record.touchedPaths, "$.touchedPaths", issues, relativePath, true); boundedString(record.rationale, "$.rationale", issues); boundedString(record.expectedInvariant, "$.expectedInvariant", issues);
  if (requireRecord(record.generatedBy, "$.generatedBy", issues)) { unknownKeys(record.generatedBy, ["actor", "model"], "$.generatedBy", issues); enumValue(record.generatedBy.actor, ["fake-model", "gpt-6-astra", "human"], "$.generatedBy.actor", issues); if (hasOwn(record.generatedBy, "model")) boundedString(record.generatedBy.model, "$.generatedBy.model", issues); }
});
export const validateVerificationPlan = (value) => validateSimple(value, "VerificationPlan", ["candidatePatchId", "baseRevision", "baselineCommand", "verificationCommands", "timeoutMs", "networkAccess"], (record, issues) => {
  idValue(record.candidatePatchId, "$.candidatePatchId", issues); if (requireRecord(record.baseRevision, "$.baseRevision", issues)) { boundedString(record.baseRevision.repository, "$.baseRevision.repository", issues); boundedString(record.baseRevision.revision, "$.baseRevision.revision", issues); } validateCommand(record.baselineCommand, "$.baselineCommand", issues); if (arrayValue(record.verificationCommands, "$.verificationCommands", issues)) record.verificationCommands.forEach((command, index) => validateCommand(command, `$.verificationCommands[${index}]`, issues)); finiteInteger(record.timeoutMs, "$.timeoutMs", issues, 1, MAX_COMMAND_TIMEOUT_MS); enumValue(record.networkAccess, ["disabled", "allowlisted"], "$.networkAccess", issues);
});
export const validateVerificationResult = (value) => validateSimple(value, "VerificationResult", ["verificationPlanId", "classification", "baselineExitCode", "patchedExitCode", "evidenceIds", "failure"], (record, issues) => {
  idValue(record.verificationPlanId, "$.verificationPlanId", issues); enumValue(record.classification, ["verified", "regressed", "not-reproduced", "inconclusive"], "$.classification", issues); ["baselineExitCode", "patchedExitCode"].forEach((key) => { if (record[key] !== null && !Number.isSafeInteger(record[key])) issue(issues, `$.${key}`, "invalid_integer"); }); uniqueStrings(record.evidenceIds, "$.evidenceIds", issues, idValue); if (hasOwn(record, "failure") && requireRecord(record.failure, "$.failure", issues)) { unknownKeys(record.failure, ["code", "message"], "$.failure", issues); boundedString(record.failure.code, "$.failure.code", issues); boundedString(record.failure.message, "$.failure.message", issues); }
});
export const validateRecoveryReport = (value) => validateSimple(value, "RecoveryReport", ["status", "hypothesisSetId", "candidatePatchIds", "verificationResultIds", "facts", "inferences", "unknowns", "approvalRequired"], (record, issues) => {
  enumValue(record.status, ["verified", "regressed", "not-reproduced", "inconclusive"], "$.status", issues); idValue(record.hypothesisSetId, "$.hypothesisSetId", issues); uniqueStrings(record.candidatePatchIds, "$.candidatePatchIds", issues, idValue); uniqueStrings(record.verificationResultIds, "$.verificationResultIds", issues, idValue); uniqueStrings(record.facts, "$.facts", issues); uniqueStrings(record.inferences, "$.inferences", issues); uniqueStrings(record.unknowns, "$.unknowns", issues); if (record.approvalRequired !== true) issue(issues, "$.approvalRequired", "must_be_true");
});

export const isIncidentId = (value) => validateIncidentId(value).ok;
export const isManifestId = (value) => validateManifestId(value).ok;
export const isEvidenceId = (value) => validateEvidenceId(value).ok;
export const isAuditEventId = (value) => validateAuditEventId(value).ok;
export const isCorrelationId = (value) => validateCorrelationId(value).ok;
export const isTimestamp = (value) => validateTimestamp(value).ok;
export const isSha256Hash = (value) => validateSha256Hash(value).ok;
