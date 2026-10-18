import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCandidatePatches, fetchHypotheses } from "./patches";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("patch API client", () => {
  it("loads the hypothesis set for an incident", async () => {
    const hypotheses = { kind: "HypothesisSet", hypotheses: [{ statement: "Connection pool exhaustion" }] };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(hypotheses), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    await expect(fetchHypotheses("RIFT/042")).resolves.toEqual(hypotheses);
    expect(fetchMock).toHaveBeenCalledWith("/api/incidents/RIFT%2F042/hypotheses", { headers: { Accept: "application/json" } });
  });

  it("unwraps candidate patches from the incident patch response", async () => {
    const patches = [{ id: "patch-1", diff: "- old\n+ new", touchedPaths: ["src/server.ts"] }];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(patches), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    await expect(fetchCandidatePatches("RIFT-042")).resolves.toEqual(patches);
    expect(fetchMock).toHaveBeenCalledWith("/api/incidents/RIFT-042/patches", { headers: { Accept: "application/json" } });
  });

  it("exposes API errors for patch data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Incident not found" }), { status: 404, headers: { "Content-Type": "application/json" } }),
    );

    await expect(fetchHypotheses("missing")).rejects.toThrow("Incident not found");
  });
});
