export type IncidentSeverity = "SEV-1" | "SEV-2" | "SEV-3" | "SEV-4";
export type IncidentStatus = "investigating" | "mitigated" | "resolved";
export type IncidentStage = "detected" | "reproduced" | "root-cause-identified" | "patch-review";

export interface IncidentTimelineEvent {
  timestamp: string;
  title: string;
  detail: string;
}

export interface Incident {
  id: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  stage: IncidentStage;
  title: string;
  summary: string;
  service: string;
  repository: string;
  commit: string;
  detectedAt: string;
  updatedAt: string;
  evidenceCount: number;
  demo: boolean;
  timeline: IncidentTimelineEvent[];
}

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

export function fetchIncidents(): Promise<Incident[]> {
  return request<Incident[]>("/api/incidents");
}

export function fetchIncident(id: string): Promise<Incident> {
  return request<Incident>(`/api/incidents/${encodeURIComponent(id)}`);
}
