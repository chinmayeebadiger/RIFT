import type { CandidatePatch, HypothesisSet, PatchGenerationResponse } from "@rift/core";

export type { CandidatePatch, Hypothesis, HypothesisSet } from "@rift/core";

const API_BASE_URL = (process.env.NEXT_PUBLIC_RIFT_API_URL ?? "").replace(/\/$/, "");

async function request<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Keep the status-based message when the API response is not JSON.
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

export function fetchHypotheses(incidentId: string): Promise<HypothesisSet> {
  return request<HypothesisSet>(`/api/incidents/${encodeURIComponent(incidentId)}/hypotheses`);
}

export async function fetchCandidatePatches(incidentId: string): Promise<CandidatePatch[]> {
  const response = await request<CandidatePatch[] | { patches?: CandidatePatch[]; candidatePatches?: CandidatePatch[] } | PatchGenerationResponse>(`/api/incidents/${encodeURIComponent(incidentId)}/patches`);
  if (Array.isArray(response)) return response;
  if (Array.isArray(response.patches)) return response.patches as CandidatePatch[];
  if (Array.isArray(response.candidatePatches)) return [...response.candidatePatches];
  return [];
}
