import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchIncident, fetchIncidents } from "./incidents";

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
});
