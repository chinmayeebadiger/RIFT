import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchIncident, fetchIncidents, fetchRecoveryReport, submitApprovalIntent, verificationStatusLabel } from "./incidents";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("incident API client", () => {
  it("loads the incident list from the dashboard API", async () => {
    const incidents = [{ id: "RIFT-042" }];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(incidents), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    await expect(fetchIncidents()).resolves.toEqual(incidents);
    expect(fetchMock).toHaveBeenCalledWith("/api/incidents", { headers: { Accept: "application/json" } });
  });

  it("encodes an incident id and exposes API errors", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Incident not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(fetchIncident("RIFT/404")).rejects.toThrow("Incident not found");
    expect(fetchMock).toHaveBeenCalledWith("/api/incidents/RIFT%2F404", { headers: { Accept: "application/json" } });
  });

  it("loads the report record used for verification and approval state", async () => {
    const record = { report: { id: "report-RIFT-042", status: "verified", approvalRequired: true }, approval: { status: "pending", requestedAt: "2026-10-16T09:47:02.000Z" } };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(record), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    await expect(fetchRecoveryReport("RIFT/042")).resolves.toEqual(record);
    expect(fetchMock).toHaveBeenCalledWith("/api/incidents/RIFT%2F042/report", { headers: { Accept: "application/json" } });
  });

  it("sends an explicitly human approval intent without a production action", async () => {
    const record = { report: { id: "report-RIFT-042", status: "verified", approvalRequired: true }, approval: { status: "approved" } };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(record), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    await expect(submitApprovalIntent("report/RIFT-042", { actorId: "maya", actorKind: "human", decision: "approved", note: "Reviewed" })).resolves.toEqual(record);
    expect(fetchMock).toHaveBeenCalledWith("/api/reports/report%2FRIFT-042/approval", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-rift-actor": "maya",
        "x-rift-actor-kind": "human",
      },
      body: JSON.stringify({ actorId: "maya", actorKind: "human", decision: "approved", note: "Reviewed" }),
    });
  });

  it("keeps every verification outcome human-readable", () => {
    expect(verificationStatusLabel("running")).toBe("Running");
    expect(verificationStatusLabel("verified")).toBe("Verified");
    expect(verificationStatusLabel("regressed")).toBe("Regressed");
    expect(verificationStatusLabel("not-reproduced")).toBe("Not reproduced");
    expect(verificationStatusLabel("inconclusive")).toBe("Inconclusive");
    expect(verificationStatusLabel("cancelled")).toBe("Cancelled");
    expect(verificationStatusLabel("policy-denied")).toBe("Policy denied");
  });
});
