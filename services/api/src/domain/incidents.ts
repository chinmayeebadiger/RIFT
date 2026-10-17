export type IncidentSeverity = "SEV-1" | "SEV-2" | "SEV-3" | "SEV-4";

export type IncidentStatus = "investigating" | "mitigated" | "resolved";

export type IncidentStage =
  | "detected"
  | "reproduced"
  | "root-cause-identified"
  | "patch-review";

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
  demo: true;
  timeline: IncidentTimelineEvent[];
}

/** Demo-only in-memory records used by the initial API skeleton. */
export const demoIncidents: readonly Incident[] = [
  {
    id: "RIFT-042",
    severity: "SEV-2",
    status: "investigating",
    stage: "patch-review",
    title: "Checkout API elevated error rate",
    summary:
      "Payment retries are exhausting the connection pool and causing intermittent checkout failures.",
    service: "checkout-api",
    repository: "payments-platform",
    commit: "8f3a1d2",
    detectedAt: "2026-10-16T09:41:12.000Z",
    updatedAt: "2026-10-16T09:47:02.000Z",
    evidenceCount: 3,
    demo: true,
    timeline: [
      {
        timestamp: "2026-10-16T09:41:12.000Z",
        title: "Incident detected",
        detail: "Error rate crossed the 5% threshold on checkout-api.",
      },
      {
        timestamp: "2026-10-16T09:42:08.000Z",
        title: "Baseline reproduced",
        detail: "Reproduction confirmed on commit 8f3a1d2 in an isolated workspace.",
      },
      {
        timestamp: "2026-10-16T09:44:36.000Z",
        title: "Root cause identified",
        detail: "Connection pool is exhausted when payment retries overlap.",
      },
      {
        timestamp: "2026-10-16T09:47:02.000Z",
        title: "Candidate patch generated",
        detail: "Patch adds bounded backoff and releases the stale connection.",
      },
    ],
  },
  {
    id: "RIFT-041",
    severity: "SEV-3",
    status: "mitigated",
    stage: "reproduced",
    title: "Search API latency regression",
    summary: "A recent index refresh increased p95 search latency for a subset of queries.",
    service: "search-api",
    repository: "discovery-platform",
    commit: "b71c904",
    detectedAt: "2026-10-16T08:18:04.000Z",
    updatedAt: "2026-10-16T08:36:41.000Z",
    evidenceCount: 2,
    demo: true,
    timeline: [
      {
        timestamp: "2026-10-16T08:18:04.000Z",
        title: "Incident detected",
        detail: "Search p95 exceeded the service objective.",
      },
      {
        timestamp: "2026-10-16T08:36:41.000Z",
        title: "Baseline reproduced",
        detail: "Latency regression reproduced against the current index configuration.",
      },
    ],
  },
  {
    id: "RIFT-039",
    severity: "SEV-4",
    status: "resolved",
    stage: "root-cause-identified",
    title: "Token refresh failures",
    summary: "Expired refresh tokens were rejected during a short-lived key rotation window.",
    service: "identity-api",
    repository: "identity-platform",
    commit: "42ac19e",
    detectedAt: "2026-10-15T16:02:19.000Z",
    updatedAt: "2026-10-15T17:11:33.000Z",
    evidenceCount: 4,
    demo: true,
    timeline: [
      {
        timestamp: "2026-10-15T16:02:19.000Z",
        title: "Incident detected",
        detail: "Refresh token failures increased above the alert threshold.",
      },
      {
        timestamp: "2026-10-15T17:11:33.000Z",
        title: "Root cause identified",
        detail: "The key rotation window was not shared across identity replicas.",
      },
    ],
  },
];

export function findIncident(id: string): Incident | undefined {
  return demoIncidents.find((incident) => incident.id === id);
}
