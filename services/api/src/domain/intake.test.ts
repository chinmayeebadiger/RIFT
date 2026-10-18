import { describe, expect, it } from "vitest";
import { InMemoryEvidenceStore } from "./evidence-store.js";
import { intakeIncidentManifest, ManifestValidationError, MAX_MANIFEST_BYTES } from "./intake.js";

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "IncidentManifest",
    id: "manifest-1",
    incidentId: "RIFT-042",
    correlationId: "run-1",
    createdAt: "2026-10-18T10:00:00.000Z",
    repositoryRevision: { repository: "rift", revision: "abcdef1" },
    allowedPaths: ["src/server.ts"],
    logSources: [{ id: "app-log", type: "log", locator: "test/fixture.log" }],
    reproductionCommand: { command: "node", args: ["scripts/reproduce.js"] },
    testCommands: [{ command: "npm", args: ["test"] }],
    timeWindow: { start: "2026-10-18T09:00:00.000Z", end: "2026-10-18T10:00:00.000Z" },
    policy: { networkAccess: "disabled", allowedCommands: ["node", "npm"] },
    ...overrides,
  };
}

describe("incident manifest intake", () => {
  it("normalizes hashes and appends deterministic manifest evidence", () => {
    const firstStore = new InMemoryEvidenceStore();
    const secondStore = new InMemoryEvidenceStore();
    const first = intakeIncidentManifest(validManifest({ allowedPaths: ["src\\server.ts"] }), firstStore);
    const second = intakeIncidentManifest(validManifest(), secondStore);
    expect(first.manifestHash).toBe(second.manifestHash);
    expect(first.manifest).toEqual(second.manifest);
    expect(firstStore.list({ sourceType: "incident-manifest" })).toHaveLength(1);
    expect(intakeIncidentManifest(validManifest(), firstStore).evidence).toEqual(first.evidence);
  });

  it("rejects malformed, unsafe, unauthorized, and secret-bearing input with stable paths", () => {
    expect(() => intakeIncidentManifest({ ...validManifest(), allowedPaths: ["../secret", "/etc/passwd"] }, new InMemoryEvidenceStore())).toThrow(ManifestValidationError);
    expect(() => intakeIncidentManifest(validManifest(), new InMemoryEvidenceStore(), { authorized: false })).toThrow(/not authorized/iu);
    expect(() => intakeIncidentManifest(validManifest({ reproductionCommand: { command: "node", args: ["--token=ghp_12345678901234567890"] } }), new InMemoryEvidenceStore())).toThrow(/secret-bearing/iu);
    expect(() => intakeIncidentManifest(validManifest({ reproductionCommand: { command: "sh", args: ["-c", "node test.js"] } }), new InMemoryEvidenceStore())).toThrow(/single executable/iu);
    expect(() => intakeIncidentManifest(validManifest({ logSources: [{ id: "x", type: "url", locator: "https://example.test/log" }] }), new InMemoryEvidenceStore())).toThrow(/unsupported/iu);
    expect(() => intakeIncidentManifest(validManifest({ policy: { authorization: "denied" } }), new InMemoryEvidenceStore())).toThrow(/policy denies/iu);
    try { intakeIncidentManifest({ ...validManifest(), testCommands: "not-an-array" }, new InMemoryEvidenceStore()); } catch (error) {
      expect(error).toBeInstanceOf(ManifestValidationError);
      expect((error as ManifestValidationError).errors[0]).toMatchObject({ path: "$.testCommands" });
    }
  });

  it("rejects oversized manifests before import", () => {
    expect(() => intakeIncidentManifest({ ...validManifest(), repositoryRevision: { repository: "x".repeat(MAX_MANIFEST_BYTES), revision: "abcdef1" } }, new InMemoryEvidenceStore())).toThrow(/exceeds/iu);
  });
});
