import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiServer } from "./server.js";

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
});
