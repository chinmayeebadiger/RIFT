import { describe, expect, it } from "vitest";
import type { AuditEvent, EvidenceItem, IncidentManifest } from "./contracts.js";
import {
  validateAuditEvent,
  validateEvidenceId,
  validateEvidenceItem,
  validateIncidentId,
  validateIncidentManifest,
  validateSha256Hash,
  validateTimestamp,
} from "./validators.js";

const HASH = `sha256:${"a".repeat(64)}`;
const OTHER_HASH = `sha256:${"b".repeat(64)}`;
const TIMESTAMP = "2026-10-18T10:00:00.000Z";

function validManifest(): IncidentManifest {
  return {
    schemaVersion: 1,
    kind: "IncidentManifest",
    id: "manifest-1",
    incidentId: "RIFT-042",
    correlationId: "run-1",
    createdAt: TIMESTAMP,
    contentHash: HASH,
    repositoryRevision: {
      repository: "payments-platform",
      revision: "0123456789abcdef0123456789abcdef01234567",
    },
    allowedPaths: ["src", "tests/fixtures"],
    logSources: [{ id: "api-log", type: "log", locator: "logs/checkout.log" }],
    reproductionCommand: {
      command: "npm test",
      args: ["--", "checkout"],
      workingDirectory: "services/api",
    },
    testCommands: [{ command: "npm test", workingDirectory: "services/api" }],
    timeWindow: {
      start: TIMESTAMP,
      end: "2026-10-18T10:05:00.000Z",
    },
    policy: {
      networkAccess: "disabled",
      maxEvidenceBytes: 100_000,
      redactSecrets: true,
    },
  };
}

function validEvidence(): EvidenceItem {
  return {
    schemaVersion: 1,
    kind: "EvidenceItem",
    id: "evidence-1",
    incidentId: "RIFT-042",
    correlationId: "run-1",
    createdAt: TIMESTAMP,
    contentHash: HASH,
    content: { message: "synthetic failure", count: 1 },
    source: { type: "log", locator: "logs/checkout.log" },
    capturedAt: TIMESTAMP,
    redaction: { status: "redacted", rules: ["authorization-header"] },
    provenance: {
      actor: "incident-intake",
      tool: "fixture-loader",
      sourceHash: OTHER_HASH,
      metadata: { fixture: "checkout" },
    },
  };
}

function validAuditEvent(): AuditEvent {
  return {
    schemaVersion: 1,
    kind: "AuditEvent",
    id: "audit-1",
    incidentId: "RIFT-042",
    correlationId: "run-1",
    createdAt: TIMESTAMP,
    contentHash: HASH,
    occurredAt: TIMESTAMP,
    actor: { kind: "system", id: "rift-api" },
    action: "intake.validate",
    policyDecision: { outcome: "allowed", policyId: "default", reasonCode: "within-scope" },
    result: "succeeded",
    inputHashes: [OTHER_HASH],
    outputHashes: [HASH],
  };
}

function issueCodes(result: { readonly ok: boolean; readonly issues?: readonly { readonly path: string; readonly code: string }[] }): readonly string[] {
  return result.ok ? [] : result.issues?.map(({ path, code }) => `${path}:${code}`) ?? [];
}

describe("M1 domain contract validators", () => {
  it("accepts all valid contracts and JSON round trips", () => {
    for (const contract of [validManifest(), validEvidence(), validAuditEvent()]) {
      const result =
        contract.kind === "IncidentManifest"
          ? validateIncidentManifest(JSON.parse(JSON.stringify(contract)))
          : contract.kind === "EvidenceItem"
            ? validateEvidenceItem(JSON.parse(JSON.stringify(contract)))
            : validateAuditEvent(JSON.parse(JSON.stringify(contract)));
      expect(result).toEqual({ ok: true, value: contract });
    }
  });

  it("rejects unsupported root values, unknown keys, and future schema versions", () => {
    expect(validateIncidentManifest(null).ok).toBe(false);
    expect(validateIncidentManifest([]).ok).toBe(false);
    expect(validateIncidentManifest(true).ok).toBe(false);

    const withUnknownKey = { ...validManifest(), unexpected: true };
    expect(issueCodes(validateIncidentManifest(withUnknownKey))).toContain("$.unexpected:unknown_key");

    const withNestedUnknownKey = {
      ...validManifest(),
      policy: { ...validManifest().policy, typo: "deny" },
    };
    expect(issueCodes(validateIncidentManifest(withNestedUnknownKey))).toContain("$.policy.typo:unknown_key");

    expect(issueCodes(validateIncidentManifest({ ...validManifest(), schemaVersion: 2 }))).toContain(
      "$.schemaVersion:unsupported_schema_version",
    );
    expect(issueCodes(validateIncidentManifest({ ...validManifest(), schemaVersion: "1" }))).toContain(
      "$.schemaVersion:unsupported_schema_version",
    );
  });

  it("validates IDs, canonical UTC timestamps, and SHA-256 hashes", () => {
    expect(validateIncidentId("RIFT-042").ok).toBe(true);
    expect(validateIncidentId("550e8400-e29b-41d4-a716-446655440000").ok).toBe(true);
    for (const invalid of ["", " ", "RIFT/042", "RIFT\u0000-042", "a".repeat(129)]) {
      expect(validateIncidentId(invalid).ok).toBe(false);
    }

    expect(validateTimestamp(TIMESTAMP).ok).toBe(true);
    for (const invalid of [
      "2026-10-18T10:00:00Z",
      "2026-10-18T10:00:00.000+01:00",
      "2026-02-30T10:00:00.000Z",
      "2026-10-18T10:00:60.000Z",
      123,
    ]) {
      expect(validateTimestamp(invalid).ok).toBe(false);
    }

    expect(validateSha256Hash(HASH).ok).toBe(true);
    for (const invalid of ["a".repeat(64), `sha256:${"A".repeat(64)}`, `sha256:${"a".repeat(63)}`]) {
      expect(validateSha256Hash(invalid).ok).toBe(false);
    }
  });

  it("rejects unsafe manifest paths, duplicates, malformed commands, and time windows", () => {
    const invalid = validManifest();
    const malformed = {
      ...invalid,
      allowedPaths: ["src", "src", "../secrets", "/absolute", "windows\\path"],
      reproductionCommand: { command: "npm test", workingDirectory: "../outside" },
      timeWindow: { start: "2026-10-18T11:00:00.000Z", end: TIMESTAMP },
    };
    const result = validateIncidentManifest(malformed);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toEqual(expect.arrayContaining([
      "$.allowedPaths[1]:duplicate_value",
      "$.allowedPaths[2]:invalid_relative_path",
      "$.allowedPaths[3]:invalid_relative_path",
      "$.allowedPaths[4]:invalid_relative_path",
      "$.reproductionCommand.workingDirectory:invalid_relative_path",
      "$.timeWindow:invalid_order",
    ]));
  });

  it("rejects invalid evidence provenance and oversized content without mutation", () => {
    const evidence = validEvidence();
    const before = JSON.stringify(evidence);
    const invalid = {
      ...evidence,
      content: "x".repeat(1_048_577),
      provenance: { ...evidence.provenance, metadata: { ...evidence.provenance.metadata, bad: NaN } },
    };
    expect(validateEvidenceItem(invalid).ok).toBe(false);
    expect(JSON.stringify(evidence)).toBe(before);

    expect(validateEvidenceItem({ ...evidence, redaction: undefined }).ok).toBe(false);
    expect(validateEvidenceItem({ ...evidence, contentHash: "sha256:bad" }).ok).toBe(false);
  });

  it("enforces audit result, policy, failure, and hash-reference invariants", () => {
    expect(validateAuditEvent(validAuditEvent()).ok).toBe(true);
    expect(validateAuditEvent({ ...validAuditEvent(), result: "failed" }).ok).toBe(false);
    expect(validateAuditEvent({ ...validAuditEvent(), result: "denied", policyDecision: { ...validAuditEvent().policyDecision, outcome: "allowed" }, failure: { code: "blocked" } }).ok).toBe(false);
    expect(validateAuditEvent({ ...validAuditEvent(), inputHashes: [HASH, HASH] }).ok).toBe(false);
    expect(validateAuditEvent({ ...validAuditEvent(), failure: { code: "should-not-be-here" } }).ok).toBe(false);
  });

  it("returns stable issue ordering for the same malformed input", () => {
    const malformed = { ...validManifest(), id: "", schemaVersion: 2, unexpected: true };
    expect(issueCodes(validateIncidentManifest(malformed))).toEqual(issueCodes(validateIncidentManifest(malformed)));
  });
});
