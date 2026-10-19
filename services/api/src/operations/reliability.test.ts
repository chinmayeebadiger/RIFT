import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RecoveryPipelineError } from "../pipeline/index.js";
import { createApiServer } from "../server.js";
import { runBoundedRequests } from "./reliability-harness.js";

interface JsonResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function recoveryManifest(incidentId: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "IncidentManifest",
    id: `manifest-${incidentId}`,
    incidentId,
    correlationId: `run-${incidentId}`,
    createdAt: "2026-10-18T10:00:00.000Z",
    repositoryRevision: { repository: "rift", revision: "abcdef1" },
    allowedPaths: ["demo/src/domain/shop.ts"],
    logSources: [{ id: "demo-log", type: "log", locator: "tests/fixtures/integrated-recovery/observations.log" }],
    reproductionCommand: { command: "node", args: ["demo-regression-fixture"] },
    testCommands: [{ command: "node", args: ["demo-check-fixture"] }],
    timeWindow: { start: "2026-10-18T09:00:00.000Z", end: "2026-10-18T10:00:00.000Z" },
    policy: { networkAccess: "disabled", allowedCommands: ["node"] },
  };
}

async function start(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function stop(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function jsonResponse(response: Response): Promise<JsonResponse> {
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("M6 API operational reliability", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createApiServer();
    baseUrl = await start(server);
  });

  afterAll(async () => {
    await stop(server);
  });

  it("serves a bounded concurrent health workload with no request failures", async () => {
    const metrics = await runBoundedRequests({
      count: 24,
      concurrency: 4,
      request: async () => jsonResponse(await fetch(`${baseUrl}/health`)),
    });

    expect(metrics.requestCount).toBe(24);
    expect(metrics.completedCount).toBe(24);
    expect(metrics.errorCount).toBe(0);
    expect(metrics.maxInFlight).toBeLessThanOrEqual(4);
    expect(metrics.latenciesMs).toHaveLength(24);
    expect(metrics.results.every((result) => result?.status === 200 && result.body.status === "ok")).toBe(true);
  });

  it("keeps health responsive while malformed and oversized requests return structured errors", async () => {
    const workload = ["malformed", "oversized", "health", "health", "health", "health"] as const;
    const metrics = await runBoundedRequests({
      count: workload.length,
      concurrency: 3,
      request: async (index) => {
        const kind = workload[index];
        if (kind === "health") return { kind, ...(await jsonResponse(await fetch(`${baseUrl}/health`))) };
        const body = kind === "malformed" ? "{broken" : "x".repeat(256 * 1024 + 1);
        const response = await fetch(`${baseUrl}/api/incidents/intake`, {
          method: "POST",
          headers: { "content-type": "application/json", "content-length": String(body.length) },
          body,
        });
        return { kind, ...(await jsonResponse(response)) };
      },
    });

    expect(metrics.requestCount).toBe(workload.length);
    expect(metrics.completedCount).toBe(workload.length);
    expect(metrics.errorCount).toBe(0);
    expect(metrics.maxInFlight).toBeLessThanOrEqual(3);

    const resultAt = (index: number): JsonResponse & { readonly kind: string } => {
      const result = metrics.results[index];
      if (result === undefined) throw new Error(`missing result at index ${index}`);
      return result;
    };
    expect(resultAt(0)).toMatchObject({ kind: "malformed", status: 400, body: { code: "MALFORMED_JSON" } });
    expect(resultAt(1)).toMatchObject({ kind: "oversized", status: 413, body: { code: "BODY_TOO_LARGE" } });
    for (const index of [2, 3, 4, 5]) {
      expect(resultAt(index)).toMatchObject({ kind: "health", status: 200, body: { status: "ok" } });
    }
  });

  it("returns a structured pipeline failure and remains responsive afterward", async () => {
    const failingServer = createApiServer({
      pipelineFactory: () => ({
        run: async () => {
          throw new RecoveryPipelineError("PIPELINE_FAILED", "synthetic pipeline failure");
        },
      }),
    });
    const failingBaseUrl = await start(failingServer);
    try {
      const [failure, health] = await Promise.all([
        fetch(`${failingBaseUrl}/api/incidents/RIFT-M6-FAILURE/recovery`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            manifest: recoveryManifest("RIFT-M6-FAILURE"),
            evidence: [],
            expectedBaselineFailure: { code: "EXPECTED", signature: "4 failed" },
          }),
        }),
        fetch(`${failingBaseUrl}/health`),
      ]);

      expect(failure.status).toBe(422);
      expect(await failure.json()).toEqual({ error: "synthetic pipeline failure", code: "PIPELINE_FAILED" });
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ service: "rift-api", status: "ok" });
    } finally {
      await stop(failingServer);
    }
  });
});
