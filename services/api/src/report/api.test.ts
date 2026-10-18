import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { RecoveryReport } from "@rift/core";
import { createApiServer } from "../server.js";
import { sha256 } from "../domain/hashing.js";
import { InMemoryReportStore } from "./store.js";

const reportWithoutHash: Omit<RecoveryReport, "contentHash"> = {
  kind: "RecoveryReport",
  schemaVersion: 1,
  id: "report-api-1",
  incidentId: "RIFT-042",
  correlationId: "run-api-1",
  createdAt: "2026-10-18T10:00:00.000Z",
  status: "inconclusive",
  hypothesisSetId: "hypotheses-api-1",
  candidatePatchIds: [],
  verificationResultIds: [],
  facts: ["No verification result was available."],
  inferences: [],
  unknowns: ["The patched workspace was not tested."],
  evidenceCitations: [],
  hypotheses: [],
  patches: [],
  commands: [],
  environmentFingerprint: null,
  baselineResults: [],
  patchedResults: [],
  evidenceIds: [],
  approvalRequired: true,
};
const report: RecoveryReport = { ...reportWithoutHash, contentHash: sha256(reportWithoutHash as never) };

describe("recovery report API", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server === undefined) return;
    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
    server = undefined;
  });

  it("reads a report with pending state and records an explicit human decision", async () => {
    const store = new InMemoryReportStore([{ report, approval: { status: "pending", requestedAt: report.createdAt } }]);
    server = createApiServer({ reportStore: store });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const read = await fetch(`${baseUrl}/api/reports/${report.id}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ report: { id: report.id, approvalRequired: true }, approval: { status: "pending" } });

    const approval = await fetch(`${baseUrl}/api/reports/${report.id}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rift-actor": "human-reviewer" },
      body: JSON.stringify({ decision: "approved", note: "Evidence and candidate diff reviewed." }),
    });
    expect(approval.status).toBe(200);
    expect(await approval.json()).toMatchObject({ approval: { status: "approved", approverId: "human-reviewer" } });

    const second = await fetch(`${baseUrl}/api/reports/${report.id}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rift-actor": "another-reviewer" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(second.status).toBe(409);
  });

  it("requires a human decision and exposes no production mutation route", async () => {
    const store = new InMemoryReportStore([{ report, approval: { status: "pending", requestedAt: report.createdAt } }]);
    server = createApiServer({ reportStore: store });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const missingActor = await fetch(`${baseUrl}/api/reports/${report.id}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(missingActor.status).toBe(400);
    expect((await missingActor.json()).code).toBe("APPROVAL_INVALID");

    const mutation = await fetch(`${baseUrl}/api/reports/${report.id}/apply`, { method: "POST" });
    expect(mutation.status).toBe(405);
  });

  it("rejects malformed report generation input at the API boundary", async () => {
    server = createApiServer({ reportStore: new InMemoryReportStore() });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/reports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "REPORT_INPUT_INVALID" });
  });
});
