import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryEvidenceStore } from "./domain/evidence-store.js";
import { withEvidenceHash } from "./domain/hashing.js";
import { intakeIncidentManifest, ManifestValidationError, MAX_MANIFEST_BYTES } from "./domain/intake.js";
import { redactEvidenceForModel } from "./domain/redaction.js";
import { validateIncidentManifest } from "./domain/validators.js";
import { createApiServer } from "./server.js";

const FIXTURE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../tests/fixtures/m1-synthetic-incident");

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(FIXTURE_ROOT, name), "utf8")) as T;
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, nested]) => [key, reverseObjectKeys(nested)]),
  );
}

interface ExpectedFixture {
  readonly expectedFailureSignature: {
    readonly name: string;
    readonly status: number;
    readonly message: string;
  };
  readonly expectedIntake: {
    readonly acceptedStatus: number;
    readonly retryIsIdempotent: boolean;
    readonly evidenceCountAfterRetry: number;
    readonly manifestHashPattern: string;
    readonly redactionPlaceholder: string;
    readonly rejections: Record<string, { readonly status: number; readonly code: string }>;
  };
}

interface JsonResponse {
  readonly response: Response;
  readonly body: Record<string, unknown>;
}

const manifest = readFixture<Record<string, unknown>>("manifest.json");
const expected = readFixture<ExpectedFixture>("expected.json");
const log = readFileSync(resolve(FIXTURE_ROOT, "logs/checkout-api.log"), "utf8");

describe("M1 synthetic incident fixture", () => {
  let server: Server;
  let baseUrl: string;
  let evidenceStore: InMemoryEvidenceStore;

  beforeAll(async () => {
    evidenceStore = new InMemoryEvidenceStore();
    server = createApiServer({ evidenceStore });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => (error ? reject(error) : resolveClose()));
    });
  });

  async function postIntake(body: unknown, headers: Record<string, string> = {}): Promise<JsonResponse> {
    const response = await fetch(`${baseUrl}/api/incidents/intake`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { response, body: (await response.json()) as Record<string, unknown> };
  }

  it("validates the pinned fixture contract and records its failure signature", () => {
    const intake = intakeIncidentManifest(manifest, new InMemoryEvidenceStore());
    const validation = validateIncidentManifest(intake.manifest);
    expect(validation).toEqual({ ok: true, value: intake.manifest });
    expect(manifest.repositoryRevision).toMatchObject({
      repository: "rift-demo-storefront",
      revision: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(manifest.policy).toMatchObject({
      networkAccess: "disabled",
      allowedCommands: ["node", "npm"],
    });
    expect(log).toContain(`signature=${expected.expectedFailureSignature.name}`);
    expect(log).toContain(`status=${expected.expectedFailureSignature.status}`);
    expect(log).toContain(`message="${expected.expectedFailureSignature.message}"`);
    expect(log).not.toMatch(/-----BEGIN [^-]*PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_/u);
    expect(log).toContain("TEST_ONLY_SYNTHETIC_TOKEN");
  });

  it("ingests the fixture repeatedly with stable hashes and one evidence record", async () => {
    const first = await postIntake(manifest);
    const retry = await postIntake(reverseObjectKeys(manifest));

    expect(first.response.status).toBe(expected.expectedIntake.acceptedStatus);
    expect(retry.response.status).toBe(expected.expectedIntake.acceptedStatus);
    expect(expected.expectedIntake.retryIsIdempotent).toBe(true);
    expect(first.body.manifestHash).toMatch(new RegExp(expected.expectedIntake.manifestHashPattern, "u"));
    expect(retry.body.manifestHash).toBe(first.body.manifestHash);
    expect(retry.body.evidence).toEqual(first.body.evidence);
    expect(evidenceStore.list({ sourceType: "incident-manifest" })).toHaveLength(
      expected.expectedIntake.evidenceCountAfterRetry,
    );
  });

  it("redacts the fixture log before model-boundary use without mutating raw evidence", () => {
    const rawEvidence = withEvidenceHash({
      schemaVersion: 1,
      kind: "EvidenceItem",
      id: "m1-fixture-log-evidence",
      incidentId: "RIFT-M1-SYNTHETIC",
      correlationId: "m1-fixture-run",
      createdAt: "2026-10-18T10:00:00.000Z",
      capturedAt: "2026-10-18T10:00:00.000Z",
      content: log,
      source: { type: "application-log", locator: "logs/checkout-api.log" },
      redaction: { status: "not-required" as const },
      provenance: { actor: "fixture-test", tool: "fixture-loader" },
    });

    const safeEvidence = redactEvidenceForModel(rawEvidence);
    expect(rawEvidence.content).toBe(log);
    expect(safeEvidence.content).toContain(expected.expectedIntake.redactionPlaceholder);
    expect(safeEvidence.content).not.toContain("TEST_ONLY_SYNTHETIC_TOKEN");
    expect(safeEvidence.contentHash).not.toBe(rawEvidence.contentHash);
    expect(safeEvidence.redaction.status).toBe("redacted");
  });

  it("rejects malformed manifests, oversized requests, unauthorized callers, and unsafe paths", async () => {
    const malformed = await postIntake({ ...manifest, unexpected: true });
    expect(malformed.response.status).toBe(expected.expectedIntake.rejections.malformedManifest.status);
    expect(malformed.body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: expected.expectedIntake.rejections.malformedManifest.code })]),
    );

    const oversizedBody = { ...manifest, oversized: "x".repeat(MAX_MANIFEST_BYTES) };
    const oversized = await postIntake(oversizedBody);
    expect(oversized.response.status).toBe(expected.expectedIntake.rejections.oversizedRequest?.status ?? 413);
    expect(oversized.body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: expected.expectedIntake.rejections.oversizedRequest?.code ?? "BODY_TOO_LARGE" })]),
    );

    const unauthorized = await postIntake(manifest, { "x-rift-authorization": "denied" });
    expect(unauthorized.response.status).toBe(expected.expectedIntake.rejections.unauthorizedCaller.status);
    expect(unauthorized.body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: expected.expectedIntake.rejections.unauthorizedCaller.code })]),
    );

    const unsafePath = await postIntake({ ...manifest, allowedPaths: ["../outside-fixture"] });
    expect(unsafePath.response.status).toBe(expected.expectedIntake.rejections.unauthorizedPath.status);
    expect(unsafePath.body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: expected.expectedIntake.rejections.unauthorizedPath.code })]),
    );
  });

  it("keeps direct intake rejection behavior consistent with the fixture contract", () => {
    const malformed = { ...manifest, testCommands: "not-an-array" };
    expect(() => intakeIncidentManifest(malformed, new InMemoryEvidenceStore())).toThrow(ManifestValidationError);
    try {
      intakeIncidentManifest(
        { ...manifest, repositoryRevision: { repository: "x".repeat(MAX_MANIFEST_BYTES), revision: "abcdef1" } },
        new InMemoryEvidenceStore(),
      );
      throw new Error("oversized fixture manifest was accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(ManifestValidationError);
      expect((error as ManifestValidationError).statusCode).toBe(expected.expectedIntake.rejections.oversizedManifest.status);
      expect((error as ManifestValidationError).errors[0]?.code).toBe(expected.expectedIntake.rejections.oversizedManifest.code);
    }
  });
});
