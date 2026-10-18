import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiServer } from "./server.js";

function manifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "IncidentManifest",
    id: "manifest-route-1",
    incidentId: "RIFT-042",
    correlationId: "run-route-1",
    createdAt: "2026-10-18T10:00:00.000Z",
    repositoryRevision: { repository: "rift", revision: "abcdef1" },
    allowedPaths: ["src/server.ts"],
    logSources: [{ id: "app-log", type: "log", locator: "test/fixture.log" }],
    reproductionCommand: { command: "node", args: ["scripts/reproduce.js"] },
    testCommands: [{ command: "npm", args: ["test"] }],
    timeWindow: { start: "2026-10-18T09:00:00.000Z", end: "2026-10-18T10:00:00.000Z" },
    policy: { networkAccess: "disabled", allowedCommands: ["node", "npm"] },
  };
}

describe("Rift API routes", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createApiServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("reports service health with a valid timestamp", async () => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      service: "rift-api",
      status: "ok",
      version: "0.1.0",
    });
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it("lists the demo incidents and returns a requested incident", async () => {
    const listResponse = await fetch(`${baseUrl}/api/incidents`);
    const incidents = await listResponse.json();

    expect(listResponse.status).toBe(200);
    expect(incidents).toHaveLength(3);
    expect(incidents.every((incident: { demo: boolean }) => incident.demo)).toBe(true);

    const detailResponse = await fetch(`${baseUrl}/api/incidents/RIFT-042`);
    const incident = await detailResponse.json();

    expect(detailResponse.status).toBe(200);
    expect(incident).toMatchObject({
      id: "RIFT-042",
      severity: "SEV-2",
      status: "investigating",
    });
    expect(incident.timeline).toHaveLength(4);
  });

  it("returns validated hypotheses and review-ready candidate patches for the demo incident", async () => {
    const hypothesesResponse = await fetch(`${baseUrl}/api/incidents/RIFT-042/hypotheses`);
    const hypotheses = await hypothesesResponse.json();
    const patchesResponse = await fetch(`${baseUrl}/api/incidents/RIFT-042/patches`);
    const patches = await patchesResponse.json();

    expect(hypothesesResponse.status).toBe(200);
    expect(hypotheses).toMatchObject({
      kind: "HypothesisSet",
      schemaVersion: 1,
      id: "rift-042-hypotheses",
      incidentId: "RIFT-042",
      rankingMethod: "confidence-desc",
    });
    expect(hypotheses.hypotheses).toHaveLength(2);
    expect(patchesResponse.status).toBe(200);
    expect(patches).toHaveLength(2);
    expect(patches.every((patch: { kind: string; incidentId: string; generatedBy: { actor: string } }) =>
      patch.kind === "CandidatePatch" && patch.incidentId === "RIFT-042" && patch.generatedBy.actor === "fake-model")).toBe(true);
    expect(patches.every((patch: Record<string, unknown>) => !Object.hasOwn(patch, "verificationResult"))).toBe(true);
  });

  it("returns empty validated recovery collections for other known incidents", async () => {
    const hypothesesResponse = await fetch(`${baseUrl}/api/incidents/RIFT-041/hypotheses`);
    const hypotheses = await hypothesesResponse.json();
    const patchesResponse = await fetch(`${baseUrl}/api/incidents/RIFT-041/patches`);
    const patches = await patchesResponse.json();

    expect(hypothesesResponse.status).toBe(200);
    expect(hypotheses).toMatchObject({ kind: "HypothesisSet", incidentId: "RIFT-041" });
    expect(hypotheses.hypotheses).toEqual([]);
    expect(patchesResponse.status).toBe(200);
    expect(patches).toEqual([]);
  });

  it("exposes rejected investigation state without presenting a patch", async () => {
    const hypothesesResponse = await fetch(`${baseUrl}/api/incidents/RIFT-039/hypotheses`);
    const hypotheses = await hypothesesResponse.json();
    const patchesResponse = await fetch(`${baseUrl}/api/incidents/RIFT-039/patches`);
    const patches = await patchesResponse.json();

    expect(hypothesesResponse.status).toBe(200);
    expect(hypotheses.hypotheses).toHaveLength(1);
    expect(hypotheses.hypotheses[0].status).toBe("rejected");
    expect(patchesResponse.status).toBe(200);
    expect(patches).toEqual([]);
  });

  it("returns the existing missing-incident error for recovery routes", async () => {
    const hypothesesResponse = await fetch(`${baseUrl}/api/incidents/does-not-exist/hypotheses`);
    const patchesResponse = await fetch(`${baseUrl}/api/incidents/does-not-exist/patches`);

    expect(hypothesesResponse.status).toBe(404);
    expect(await hypothesesResponse.json()).toEqual({ error: "Incident not found", id: "does-not-exist" });
    expect(patchesResponse.status).toBe(404);
    expect(await patchesResponse.json()).toEqual({ error: "Incident not found", id: "does-not-exist" });
  });

  it("returns useful errors for missing incidents and unsupported methods", async () => {
    const missingResponse = await fetch(`${baseUrl}/api/incidents/does-not-exist`);
    const missingBody = await missingResponse.json();

    expect(missingResponse.status).toBe(404);
    expect(missingBody).toEqual({
      error: "Incident not found",
      id: "does-not-exist",
    });

    const methodResponse = await fetch(`${baseUrl}/health`, { method: "POST" });
    expect(methodResponse.status).toBe(405);
    expect(await methodResponse.json()).toEqual({ error: "Method not allowed" });
  });

  it("accepts an intake manifest and reports body, JSON, and authorization failures", async () => {
    const accepted = await fetch(`${baseUrl}/api/incidents/intake`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(manifest()),
    });
    const acceptedBody = await accepted.json();
    expect(accepted.status).toBe(201);
    expect(acceptedBody.manifestHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(acceptedBody.evidence.source.type).toBe("incident-manifest");

    const malformed = await fetch(`${baseUrl}/api/incidents/intake`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{broken",
    });
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).errors[0]).toMatchObject({ code: "MALFORMED_JSON", path: "$" });

    const denied = await fetch(`${baseUrl}/api/incidents/intake`, {
      method: "POST", headers: { "x-rift-authorization": "denied" }, body: JSON.stringify(manifest()),
    });
    expect(denied.status).toBe(403);
    expect((await denied.json()).errors[0]).toMatchObject({ code: "AUTHORIZATION_DENIED", path: "$" });

    const oversizedBody = "x".repeat(256 * 1024 + 1);
    const oversized = await fetch(`${baseUrl}/api/incidents/intake`, {
      method: "POST", headers: { "content-length": String(oversizedBody.length) }, body: oversizedBody,
    });
    expect(oversized.status).toBe(413);
    expect((await oversized.json()).errors[0]).toMatchObject({ code: "BODY_TOO_LARGE", path: "$" });
  });
});
