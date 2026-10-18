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
export const MAX_DIFF_BYTES = MAX_CONTENT_BYTES;
export const MAX_PATCH_BYTES = 1_048_576;
export const MAX_PATCH_DIFF_BYTES = MAX_PATCH_BYTES;
export const DEFAULT_PROTECTED_PATHS = Object.freeze([
  ".git", ".github/workflows", ".gitlab-ci.yml", ".circleci", ".buildkite", ".travis.yml",
  "Dockerfile", "docker-compose.yml", "docker-compose.yaml", "package-lock.json", "npm-shrinkwrap.json",
  "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "Cargo.lock", "Gemfile.lock", "composer.lock",
  "poetry.lock", "Pipfile.lock", "go.sum", "Podfile.lock", "requirements.lock",
]);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/u;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^(?:[0-9a-f]{7,40}|[0-9a-f]{64})$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const UNSAFE_DIFF_CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
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

function diffString(value, path, issues) {
  if (!stringValue(value, path, issues, { maxLength: MAX_DIFF_BYTES, noControl: false })) return false;
  if (UNSAFE_DIFF_CONTROL_CHARACTER_PATTERN.test(value)) issue(issues, path, "unsafe_control_character");
  try { if (Buffer.byteLength(value, "utf8") > MAX_DIFF_BYTES) issue(issues, path, "too_large"); } catch { issue(issues, path, "invalid_type"); }
  return true;
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
  if (value.startsWith("/") || PATH_SEPARATOR_PATTERN.test(value) || /^[A-Za-z]:/u.test(value) || parts.includes("..") || parts.includes(".") || parts.includes("")) {
    issue(issues, path, "invalid_relative_path");
  }
  return true;
}

function workingDirectory(value, path, issues) {
  if (value === ".") return true;
  return relativePath(value, path, issues);
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

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u;

function patchPath(value, path, issues) {
  if (typeof value !== "string") { issue(issues, path, "invalid_type"); return false; }
  if (value.length === 0) issue(issues, path, "empty_string");
  if (value.length > MAX_STRING_LENGTH) issue(issues, path, "too_long");
  if (CONTROL_CHARACTER_PATTERN.test(value)) issue(issues, path, "control_character");
  const parts = value.split("/");
  if (value.startsWith("/") || PATH_SEPARATOR_PATTERN.test(value) || /^[A-Za-z]:/u.test(value) || parts.includes("..") || parts.includes(".") || parts.includes("")) {
    issue(issues, path, "invalid_relative_path");
    return false;
  }
  return true;
}

function patchPathFromHeader(value, prefix, path, issues) {
  if (value === "/dev/null") return value;
  if (!value.startsWith(prefix)) { issue(issues, path, "invalid_diff_path"); return null; }
  const result = value.slice(prefix.length);
  return patchPath(result, path, issues) ? result : null;
}

function patchMetadataIssue(line, path, issues) {
  const fileMode = /^(?:new file mode|deleted file mode) ([0-7]{6})$/u.exec(line);
  if (fileMode) {
    if (!["100644", "100755"].includes(fileMode[1])) issue(issues, path, "unsupported_patch");
    return true;
  }
  if (/^(?:new file mode|deleted file mode)\b/u.test(line)
    || /^(?:old mode|new mode)\b/u.test(line)
    || /^(?:similarity index|dissimilarity index|rename from|rename to|copy from|copy to)\b/u.test(line)
    || /^Binary files .* differ$/u.test(line) || line === "GIT binary patch") {
    issue(issues, path, "unsupported_patch");
    return true;
  }
  return false;
}

function parsePatchIndex(line, path, issues) {
  const match = /^index [0-9a-f]{4,64}\.{2}[0-9a-f]{4,64}(?: ([0-7]{6}))?$/u.exec(line);
  if (!match) { issue(issues, path, "malformed_metadata"); return; }
  if (match[1] !== undefined && !["100644", "100755"].includes(match[1])) issue(issues, path, "unsupported_patch");
}

function parseHunk(line, path, issues) {
  const match = HUNK_HEADER_PATTERN.exec(line);
  if (!match) { issue(issues, path, "malformed_hunk"); return null; }
  const oldStart = Number(match[1]);
  const oldCount = Number(match[2] ?? 1);
  const newStart = Number(match[3]);
  const newCount = Number(match[4] ?? 1);
  if (![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger) || (oldStart === 0 && oldCount !== 0) || (newStart === 0 && newCount !== 0)) {
    issue(issues, path, "malformed_hunk"); return null;
  }
  return { oldCount, newCount };
}

function protectedByDefault(path) {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  if (path === ".git" || path.startsWith(".git/") || path === ".github/workflows" || path.startsWith(".github/workflows/")) return true;
  if (DEFAULT_PROTECTED_PATHS.some((protectedPath) => path === protectedPath || path.startsWith(`${protectedPath}/`))) return true;
  if (/^dockerfile(?:\..*)?$/iu.test(basename) || /^docker-compose(?:\..*)?\.(?:yml|yaml)$/iu.test(basename)) return true;
  if (/^\.env(?:\..*)?$/u.test(basename) || /\.env$/u.test(basename)) return true;
  if (path.split("/").some((part) => /^(?:secrets?|credentials?)$/iu.test(part))) return true;
  if (/[.]\w*(?:pem|key|p12|pfx|jks|keystore|asc|gpg)$/iu.test(basename)) return true;
  if (/(?:secret|credential|password|passwd|private[-_]?key|api[-_]?key|access[-_]?key)/iu.test(basename)) return true;
  return false;
}

function pathMatchesScope(path, scope) { return path === scope || path.startsWith(`${scope}/`); }

function patchOptionPaths(value, path, issues) {
  if (!Array.isArray(value)) { issue(issues, path, "invalid_type"); return []; }
  const seen = new Set();
  const result = [];
  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (patchPath(entry, entryPath, issues) && typeof entry === "string") {
      if (seen.has(entry)) issue(issues, entryPath, "duplicate_value");
      seen.add(entry); result.push(entry);
    }
  });
  return result;
}

function candidatePatchSettings(options, issues) {
  if (options === undefined) return { allowedPaths: undefined, protectedPaths: [], maxPatchBytes: MAX_PATCH_BYTES };
  if (!isRecord(options)) { issue(issues, "$.options", "invalid_type"); return { allowedPaths: undefined, protectedPaths: [], maxPatchBytes: MAX_PATCH_BYTES }; }
  const context = options.context === undefined ? {} : options.context;
  if (!isRecord(context)) issue(issues, "$.options.context", "invalid_type");
  const contextRecord = isRecord(context) ? context : {};
  const allowedValue = options.allowedPaths ?? contextRecord.allowedPaths;
  const protectedPaths = [];
  for (const [key, source] of [["protectedPaths", options.protectedPaths], ["additionalProtectedPaths", options.additionalProtectedPaths], ["context.protectedPaths", contextRecord.protectedPaths], ["context.additionalProtectedPaths", contextRecord.additionalProtectedPaths]]) {
    if (source !== undefined) protectedPaths.push(...patchOptionPaths(source, `$.options.${key}`, issues));
  }
  let maxPatchBytes = MAX_PATCH_BYTES;
  const configuredLimit = options.maxPatchBytes ?? contextRecord.maxPatchBytes;
  if (configuredLimit !== undefined) {
    if (!Number.isSafeInteger(configuredLimit) || configuredLimit < 1 || configuredLimit > MAX_PATCH_BYTES) issue(issues, "$.options.maxPatchBytes", "invalid_integer");
    else maxPatchBytes = configuredLimit;
  }
  return { allowedPaths: allowedValue === undefined ? undefined : patchOptionPaths(allowedValue, "$.options.allowedPaths", issues), protectedPaths, maxPatchBytes };
}

function validatePatchDiff(diff, touchedPaths, options, issues) {
  if (typeof diff !== "string") { issue(issues, "$.diff", "invalid_type"); return; }
  if (Buffer.byteLength(diff, "utf8") > options.maxPatchBytes) issue(issues, "$.diff", "too_large");
  if (diff.length === 0) issue(issues, "$.diff", "empty_string");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(diff) || /\r/u.test(diff)) issue(issues, "$.diff", "invalid_text");
  if (!diff.endsWith("\n")) issue(issues, "$.diff", "missing_final_newline");
  if (!diff.endsWith("\n")) return;
  const lines = diff.split("\n"); lines.pop();
  const changedPaths = [];
  let index = 0;
  while (index < lines.length) {
    const header = lines[index];
    const headerMatch = /^diff --git a\/(.+) b\/(.+)$/u.exec(header);
    if (!headerMatch) { issue(issues, `$.diff.lines[${index + 1}]`, "malformed_metadata"); index += 1; continue; }
    const oldGitPath = patchPath(headerMatch[1], `$.diff.lines[${index + 1}]`, issues) ? headerMatch[1] : null;
    const newGitPath = patchPath(headerMatch[2], `$.diff.lines[${index + 1}]`, issues) ? headerMatch[2] : null;
    if (oldGitPath === null || newGitPath === null || oldGitPath !== newGitPath) issue(issues, `$.diff.lines[${index + 1}]`, "unsupported_patch");
    index += 1;
    while (index < lines.length && !lines[index].startsWith("--- ") && !lines[index].startsWith("diff --git ")) {
      if (lines[index].startsWith("index ")) parsePatchIndex(lines[index], `$.diff.lines[${index + 1}]`, issues);
      else if (!patchMetadataIssue(lines[index], `$.diff.lines[${index + 1}]`, issues)) issue(issues, `$.diff.lines[${index + 1}]`, "malformed_metadata");
      index += 1;
    }
    if (index >= lines.length || !lines[index].startsWith("--- ")) { issue(issues, "$.diff", "missing_old_file_header"); continue; }
    const oldPath = patchPathFromHeader(lines[index].slice(4), "a/", `$.diff.lines[${index + 1}]`, issues); index += 1;
    if (index >= lines.length || !lines[index].startsWith("+++ ")) { issue(issues, "$.diff", "missing_new_file_header"); continue; }
    const newPath = patchPathFromHeader(lines[index].slice(4), "b/", `$.diff.lines[${index + 1}]`, issues); index += 1;
    if (oldPath !== "/dev/null" && oldPath !== oldGitPath) issue(issues, "$.diff", "path_mismatch");
    if (newPath !== "/dev/null" && newPath !== newGitPath) issue(issues, "$.diff", "path_mismatch");
    if (oldPath === "/dev/null" && newPath === "/dev/null") issue(issues, "$.diff", "invalid_diff_path");
    const changedPath = oldPath === "/dev/null" ? newPath : newPath === "/dev/null" ? oldPath : oldPath;
    if (changedPath && changedPath !== "/dev/null") changedPaths.push(changedPath);
    let hunkCount = 0;
    while (index < lines.length && !lines[index].startsWith("diff --git ")) {
      if (lines[index].startsWith("@@")) {
        const hunk = parseHunk(lines[index], `$.diff.lines[${index + 1}]`, issues); index += 1;
        if (hunk === null) continue;
        hunkCount += 1; let oldLines = 0; let newLines = 0; let previousWasChange = false;
        while (index < lines.length && !lines[index].startsWith("diff --git ") && !lines[index].startsWith("@@")) {
          const hunkLine = lines[index];
          if (hunkLine.startsWith(" ")) { oldLines += 1; newLines += 1; previousWasChange = true; }
          else if (hunkLine.startsWith("+")) { newLines += 1; previousWasChange = true; }
          else if (hunkLine.startsWith("-")) { oldLines += 1; previousWasChange = true; }
          else if (hunkLine === "\\ No newline at end of file" && previousWasChange) previousWasChange = false;
          else { issue(issues, `$.diff.lines[${index + 1}]`, "malformed_hunk"); }
          index += 1;
        }
        if (oldLines !== hunk.oldCount || newLines !== hunk.newCount) issue(issues, `$.diff.lines[${index}]`, "hunk_line_count_mismatch");
      } else { issue(issues, `$.diff.lines[${index + 1}]`, "malformed_hunk"); index += 1; }
    }
    if (hunkCount === 0) issue(issues, "$.diff", "missing_hunk");
  }
  const touched = new Set(touchedPaths.filter((path) => typeof path === "string"));
  const extracted = new Set(changedPaths);
  if (changedPaths.length !== extracted.size || extracted.size !== touched.size || [...extracted].some((path) => !touched.has(path))) issue(issues, "$.touchedPaths", "path_mismatch");
  for (const path of extracted) {
    if (protectedByDefault(path) || options.protectedPaths.some((protectedPath) => pathMatchesScope(path, protectedPath))) issue(issues, "$.touchedPaths", "protected_path");
    if (options.allowedPaths !== undefined && !options.allowedPaths.some((allowedPath) => pathMatchesScope(path, allowedPath))) issue(issues, "$.touchedPaths", "path_out_of_scope");
  }
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
  if (hasOwn(value, "workingDirectory")) workingDirectory(value.workingDirectory, `${path}.workingDirectory`, issues);
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

function validateExpectedInvariant(value, path, issues) {
  if (!requireRecord(value, path, issues)) return false;
  unknownKeys(value, ["statement", "verificationHint"], path, issues);
  boundedString(required(value, "statement", path, issues), `${path}.statement`, issues);
  if (hasOwn(value, "verificationHint")) boundedString(value.verificationHint, `${path}.verificationHint`, issues);
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
  unknownKeys(value, ["kind", "schemaVersion", "id", "incidentId", "correlationId", "createdAt", "contentHash", "occurredAt", "actor", "action", "policyDecision", "result", "inputHashes", "outputHashes", "stage", "attempt", "failure"], "$", issues);
  enumValue(value.kind, ["AuditEvent"], "$.kind", issues);
  validateVersionedBase(value, "$", issues);
  timestampValue(required(value, "occurredAt", "$", issues), "$.occurredAt", issues);
  const actor = required(value, "actor", "$", issues);
  if (requireRecord(actor, "$.actor", issues)) {
    unknownKeys(actor, ["kind", "id"], "$.actor", issues);
    enumValue(actor.kind, ["system", "human", "worker", "model"], "$.actor.kind", issues);
    boundedString(required(actor, "id", "$.actor", issues), "$.actor.id", issues);
  }
  enumValue(value.action, ["intake.validate", "evidence.import", "policy.evaluate", "model.call", "sandbox.create", "external.action", "verification.stage", "verification.execute", "verification.patch", "verification.check", "verification.cleanup", "verification.cancel", "verification.retry"], "$.action", issues);
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
  if (hasOwn(value, "stage")) enumValue(value.stage, ["validate", "baseline", "patch", "checks", "classify", "cleanup"], "$.stage", issues);
  if (hasOwn(value, "attempt")) finiteInteger(value.attempt, "$.attempt", issues, 1, MAX_ARRAY_LENGTH);
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
export const validateCandidatePatch = (value, options) => {
  const optionIssues = [];
  const settings = candidatePatchSettings(options, optionIssues);
  const result = validateSimple(value, "CandidatePatch", ["sourceHypothesisId", "baseRevision", "diff", "touchedPaths", "rationale", "expectedInvariant", "expectedInvariantDetails", "generatedBy"], (record, issues) => {
    idValue(record.sourceHypothesisId, "$.sourceHypothesisId", issues);
    if (requireRecord(record.baseRevision, "$.baseRevision", issues)) {
      unknownKeys(record.baseRevision, ["repository", "revision"], "$.baseRevision", issues);
      boundedString(record.baseRevision.repository, "$.baseRevision.repository", issues);
      const revision = record.baseRevision.revision;
      if (typeof revision !== "string" || !REVISION_PATTERN.test(revision)) issue(issues, "$.baseRevision.revision", "invalid_repository_revision");
    }
    const validTouchedPaths = uniqueStrings(record.touchedPaths, "$.touchedPaths", issues, relativePath, true);
    stringValue(record.diff, "$.diff", issues, { maxLength: MAX_PATCH_DIFF_BYTES, noControl: false });
    boundedString(record.rationale, "$.rationale", issues); boundedString(record.expectedInvariant, "$.expectedInvariant", issues);
    if (hasOwn(record, "expectedInvariantDetails")) validateExpectedInvariant(record.expectedInvariantDetails, "$.expectedInvariantDetails", issues);
    if (requireRecord(record.generatedBy, "$.generatedBy", issues)) { unknownKeys(record.generatedBy, ["actor", "model"], "$.generatedBy", issues); enumValue(record.generatedBy.actor, ["fake-model", "gpt-6-astra", "human"], "$.generatedBy.actor", issues); if (hasOwn(record.generatedBy, "model")) boundedString(record.generatedBy.model, "$.generatedBy.model", issues); }
    if (validTouchedPaths && Array.isArray(record.touchedPaths)) validatePatchDiff(record.diff, record.touchedPaths, settings, issues);
  });
  return optionIssues.length === 0 ? result : failure([...optionIssues, ...(result.ok ? [] : result.issues)]);
};
export const validateVerificationPlan = (value) => validateSimple(value, "VerificationPlan", ["candidatePatchId", "baseRevision", "baselineCommand", "verificationCommands", "timeoutMs", "networkAccess"], (record, issues) => {
  idValue(record.candidatePatchId, "$.candidatePatchId", issues); if (requireRecord(record.baseRevision, "$.baseRevision", issues)) { boundedString(record.baseRevision.repository, "$.baseRevision.repository", issues); boundedString(record.baseRevision.revision, "$.baseRevision.revision", issues); } validateCommand(record.baselineCommand, "$.baselineCommand", issues); if (arrayValue(record.verificationCommands, "$.verificationCommands", issues)) record.verificationCommands.forEach((command, index) => validateCommand(command, `$.verificationCommands[${index}]`, issues)); finiteInteger(record.timeoutMs, "$.timeoutMs", issues, 1, MAX_COMMAND_TIMEOUT_MS); enumValue(record.networkAccess, ["disabled", "allowlisted"], "$.networkAccess", issues);
});
export const validateVerificationResult = (value) => validateSimple(value, "VerificationResult", ["verificationPlanId", "classification", "baselineExitCode", "patchedExitCode", "evidenceIds", "failure"], (record, issues) => {
  idValue(record.verificationPlanId, "$.verificationPlanId", issues); enumValue(record.classification, ["verified", "regressed", "not-reproduced", "inconclusive"], "$.classification", issues); ["baselineExitCode", "patchedExitCode"].forEach((key) => { if (record[key] !== null && !Number.isSafeInteger(record[key])) issue(issues, `$.${key}`, "invalid_integer"); }); uniqueStrings(record.evidenceIds, "$.evidenceIds", issues, idValue); if (hasOwn(record, "failure") && requireRecord(record.failure, "$.failure", issues)) { unknownKeys(record.failure, ["code", "message"], "$.failure", issues); boundedString(record.failure.code, "$.failure.code", issues); boundedString(record.failure.message, "$.failure.message", issues); }
});
export const validateRepositorySnapshot = (value) => validateSimple(value, "RepositorySnapshot", ["repositoryRevision", "files", "adapter"], (record, issues) => {
  if (requireRecord(record.repositoryRevision, "$.repositoryRevision", issues)) { unknownKeys(record.repositoryRevision, ["repository", "revision"], "$.repositoryRevision", issues); boundedString(record.repositoryRevision.repository, "$.repositoryRevision.repository", issues); if (typeof record.repositoryRevision.revision !== "string" || !REVISION_PATTERN.test(record.repositoryRevision.revision)) issue(issues, "$.repositoryRevision.revision", "invalid_repository_revision"); }
  if (arrayValue(record.files, "$.files", issues)) record.files.forEach((file, index) => { const path = `$.files[${index}]`; if (!requireRecord(file, path, issues)) return; unknownKeys(file, ["path", "contentHash", "byteLength"], path, issues); relativePath(file.path, `${path}.path`, issues); hashValue(file.contentHash, `${path}.contentHash`, issues); finiteInteger(file.byteLength, `${path}.byteLength`, issues, 0, MAX_CONTENT_BYTES); });
  if (requireRecord(record.adapter, "$.adapter", issues)) { unknownKeys(record.adapter, ["name", "version"], "$.adapter", issues); boundedString(record.adapter.name, "$.adapter.name", issues); boundedString(record.adapter.version, "$.adapter.version", issues); }
});
export const validateCommandExecution = (value) => validateSimple(value, "CommandExecution", ["snapshotId", "command", "status", "exitCode", "startedAt", "finishedAt", "stdoutEvidenceId", "stderrEvidenceId", "evidenceIds", "failure"], (record, issues) => {
  idValue(record.snapshotId, "$.snapshotId", issues); validateCommand(record.command, "$.command", issues); enumValue(record.status, ["succeeded", "failed", "timed-out", "cancelled", "blocked"], "$.status", issues); if (record.exitCode !== null && !Number.isSafeInteger(record.exitCode)) issue(issues, "$.exitCode", "invalid_integer"); timestampValue(record.startedAt, "$.startedAt", issues); timestampValue(record.finishedAt, "$.finishedAt", issues); if (hasOwn(record, "stdoutEvidenceId")) idValue(record.stdoutEvidenceId, "$.stdoutEvidenceId", issues); if (hasOwn(record, "stderrEvidenceId")) idValue(record.stderrEvidenceId, "$.stderrEvidenceId", issues); uniqueStrings(record.evidenceIds, "$.evidenceIds", issues, idValue); if (hasOwn(record, "failure") && requireRecord(record.failure, "$.failure", issues)) { unknownKeys(record.failure, ["code", "message"], "$.failure", issues); boundedString(record.failure.code, "$.failure.code", issues); boundedString(record.failure.message, "$.failure.message", issues); }
});
function validateEvidenceCitation(value, path, issues) {
  if (!requireRecord(value, path, issues)) return false;
  unknownKeys(value, ["evidenceId", "evidenceHash", "relation", "locator", "excerptHash"], path, issues);
  idValue(required(value, "evidenceId", path, issues), `${path}.evidenceId`, issues);
  hashValue(required(value, "evidenceHash", path, issues), `${path}.evidenceHash`, issues);
  enumValue(required(value, "relation", path, issues), ["supports", "contradicts", "context"], `${path}.relation`, issues);
  boundedString(required(value, "locator", path, issues), `${path}.locator`, issues);
  if (hasOwn(value, "excerptHash")) hashValue(value.excerptHash, `${path}.excerptHash`, issues);
  return true;
}

function validateRecoveryReportValue(value, issues) {
  unknownKeys(value, ["kind", "schemaVersion", "id", "incidentId", "correlationId", "createdAt", "contentHash", "status", "hypothesisSetId", "candidatePatchIds", "verificationResultIds", "facts", "inferences", "unknowns", "evidenceCitations", "hypotheses", "patches", "commands", "environmentFingerprint", "baselineResults", "patchedResults", "approvalRequired", "evidenceIds"], "$", issues);
  enumValue(value.kind, ["RecoveryReport"], "$.kind", issues);
  validateVersionedBase(value, "$", issues);
  enumValue(value.status, ["running", "verified", "regressed", "not-reproduced", "inconclusive", "cancelled", "policy-denied"], "$.status", issues);
  idValue(value.hypothesisSetId, "$.hypothesisSetId", issues);
  uniqueStrings(value.candidatePatchIds, "$.candidatePatchIds", issues, idValue);
  uniqueStrings(value.verificationResultIds, "$.verificationResultIds", issues, idValue);
  uniqueStrings(value.facts, "$.facts", issues);
  uniqueStrings(value.inferences, "$.inferences", issues);
  uniqueStrings(value.unknowns, "$.unknowns", issues);
  if (arrayValue(value.evidenceCitations, "$.evidenceCitations", issues)) value.evidenceCitations.forEach((citation, index) => validateEvidenceCitation(citation, `$.evidenceCitations[${index}]`, issues));
  if (arrayValue(value.hypotheses, "$.hypotheses", issues)) value.hypotheses.forEach((hypothesis, index) => {
    const path = `$.hypotheses[${index}]`;
    if (!requireRecord(hypothesis, path, issues)) return;
    unknownKeys(hypothesis, ["hypothesisId", "statement", "status", "confidence", "citations"], path, issues);
    idValue(hypothesis.hypothesisId, `${path}.hypothesisId`, issues);
    boundedString(hypothesis.statement, `${path}.statement`, issues);
    enumValue(hypothesis.status, ["open", "confirmed", "rejected", "inconclusive"], `${path}.status`, issues);
    if (typeof hypothesis.confidence !== "number" || !Number.isFinite(hypothesis.confidence) || hypothesis.confidence < 0 || hypothesis.confidence > 1) issue(issues, `${path}.confidence`, "invalid_number");
    if (arrayValue(hypothesis.citations, `${path}.citations`, issues)) hypothesis.citations.forEach((citation, citationIndex) => validateEvidenceCitation(citation, `${path}.citations[${citationIndex}]`, issues));
  });
  if (arrayValue(value.patches, "$.patches", issues)) value.patches.forEach((patch, index) => {
    const path = `$.patches[${index}]`;
    if (!requireRecord(patch, path, issues)) return;
    unknownKeys(patch, ["candidatePatchId", "sourceHypothesisId", "touchedPaths", "rationale", "expectedInvariant"], path, issues);
    idValue(patch.candidatePatchId, `${path}.candidatePatchId`, issues);
    idValue(patch.sourceHypothesisId, `${path}.sourceHypothesisId`, issues);
    uniqueStrings(patch.touchedPaths, `${path}.touchedPaths`, issues, relativePath, true);
    boundedString(patch.rationale, `${path}.rationale`, issues);
    boundedString(patch.expectedInvariant, `${path}.expectedInvariant`, issues);
  });
  if (arrayValue(value.commands, "$.commands", issues)) value.commands.forEach((command, index) => {
    const path = `$.commands[${index}]`;
    if (!requireRecord(command, path, issues)) return;
    unknownKeys(command, ["executionId", "command", "status", "exitCode", "evidenceIds"], path, issues);
    idValue(command.executionId, `${path}.executionId`, issues);
    validateCommand(command.command, `${path}.command`, issues);
    enumValue(command.status, ["succeeded", "failed", "timed-out", "cancelled", "blocked"], `${path}.status`, issues);
    if (command.exitCode !== null && !Number.isSafeInteger(command.exitCode)) issue(issues, `${path}.exitCode`, "invalid_integer");
    uniqueStrings(command.evidenceIds, `${path}.evidenceIds`, issues, idValue);
  });
  if (value.environmentFingerprint !== null && requireRecord(value.environmentFingerprint, "$.environmentFingerprint", issues)) {
    unknownKeys(value.environmentFingerprint, ["snapshotId", "repositoryRevision", "adapter"], "$.environmentFingerprint", issues);
    idValue(value.environmentFingerprint.snapshotId, "$.environmentFingerprint.snapshotId", issues);
    if (requireRecord(value.environmentFingerprint.repositoryRevision, "$.environmentFingerprint.repositoryRevision", issues)) {
      unknownKeys(value.environmentFingerprint.repositoryRevision, ["repository", "revision"], "$.environmentFingerprint.repositoryRevision", issues);
      boundedString(value.environmentFingerprint.repositoryRevision.repository, "$.environmentFingerprint.repositoryRevision.repository", issues);
      if (typeof value.environmentFingerprint.repositoryRevision.revision !== "string" || !REVISION_PATTERN.test(value.environmentFingerprint.repositoryRevision.revision)) issue(issues, "$.environmentFingerprint.repositoryRevision.revision", "invalid_repository_revision");
    }
    if (hasOwn(value.environmentFingerprint, "adapter") && requireRecord(value.environmentFingerprint.adapter, "$.environmentFingerprint.adapter", issues)) {
      unknownKeys(value.environmentFingerprint.adapter, ["name", "version"], "$.environmentFingerprint.adapter", issues);
      boundedString(value.environmentFingerprint.adapter.name, "$.environmentFingerprint.adapter.name", issues);
      boundedString(value.environmentFingerprint.adapter.version, "$.environmentFingerprint.adapter.version", issues);
    }
  } else if (value.environmentFingerprint !== null) issue(issues, "$.environmentFingerprint", "invalid_type");
  ["baselineResults", "patchedResults"].forEach((key) => {
    if (!arrayValue(value[key], `$.${key}`, issues)) return;
    value[key].forEach((result, index) => {
      const path = `$.${key}[${index}]`;
      if (!requireRecord(result, path, issues)) return;
      unknownKeys(result, ["verificationResultId", "exitCode", "evidenceIds"], path, issues);
      idValue(result.verificationResultId, `${path}.verificationResultId`, issues);
      if (result.exitCode !== null && !Number.isSafeInteger(result.exitCode)) issue(issues, `${path}.exitCode`, "invalid_integer");
      uniqueStrings(result.evidenceIds, `${path}.evidenceIds`, issues, idValue);
    });
  });
  if (value.approvalRequired !== true) issue(issues, "$.approvalRequired", "must_be_true");
  uniqueStrings(value.evidenceIds, "$.evidenceIds", issues, idValue);
}
export const validateRecoveryReport = (value) => validateContract(value, validateRecoveryReportValue);

export const validateInvestigationResult = (value) => validateSimple(value, "InvestigationResult", ["snapshotId", "commandExecutionIds", "logNormalizationIds", "timelineId", "hypothesisSetId", "hypothesisEvidence", "evidenceIds", "status", "facts", "inferences", "unknowns", "failure"], (record, issues) => {
  idValue(record.snapshotId, "$.snapshotId", issues); uniqueStrings(record.commandExecutionIds, "$.commandExecutionIds", issues, idValue); uniqueStrings(record.logNormalizationIds, "$.logNormalizationIds", issues, idValue); idValue(record.timelineId, "$.timelineId", issues); idValue(record.hypothesisSetId, "$.hypothesisSetId", issues); if (arrayValue(record.hypothesisEvidence, "$.hypothesisEvidence", issues)) record.hypothesisEvidence.forEach((item, index) => { if (!requireRecord(item, `$.hypothesisEvidence[${index}]`, issues)) return; unknownKeys(item, ["hypothesisId", "citations"], `$.hypothesisEvidence[${index}]`, issues); idValue(item.hypothesisId, `$.hypothesisEvidence[${index}].hypothesisId`, issues); if (arrayValue(item.citations, `$.hypothesisEvidence[${index}].citations`, issues)) item.citations.forEach((citation, citationIndex) => { const path = `$.hypothesisEvidence[${index}].citations[${citationIndex}]`; if (!requireRecord(citation, path, issues)) return; unknownKeys(citation, ["evidenceId", "evidenceHash", "relation", "locator", "excerptHash"], path, issues); idValue(citation.evidenceId, `${path}.evidenceId`, issues); hashValue(citation.evidenceHash, `${path}.evidenceHash`, issues); enumValue(citation.relation, ["supports", "contradicts", "context"], `${path}.relation`, issues); boundedString(citation.locator, `${path}.locator`, issues); if (hasOwn(citation, "excerptHash")) hashValue(citation.excerptHash, `${path}.excerptHash`, issues); }); }); uniqueStrings(record.evidenceIds, "$.evidenceIds", issues, idValue); enumValue(record.status, ["completed", "inconclusive", "failed"], "$.status", issues); uniqueStrings(record.facts, "$.facts", issues); uniqueStrings(record.inferences, "$.inferences", issues); uniqueStrings(record.unknowns, "$.unknowns", issues); if (hasOwn(record, "failure") && requireRecord(record.failure, "$.failure", issues)) { unknownKeys(record.failure, ["code", "message"], "$.failure", issues); boundedString(record.failure.code, "$.failure.code", issues); boundedString(record.failure.message, "$.failure.message", issues); }
});

export const isIncidentId = (value) => validateIncidentId(value).ok;
export const isManifestId = (value) => validateManifestId(value).ok;
export const isEvidenceId = (value) => validateEvidenceId(value).ok;
export const isAuditEventId = (value) => validateAuditEventId(value).ok;
export const isCorrelationId = (value) => validateCorrelationId(value).ok;
export const isTimestamp = (value) => validateTimestamp(value).ok;
export const isSha256Hash = (value) => validateSha256Hash(value).ok;
