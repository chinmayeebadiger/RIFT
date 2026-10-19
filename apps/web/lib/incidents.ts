import type { IncidentId } from "@rift/core";

export type IncidentSeverity = "SEV-1" | "SEV-2" | "SEV-3" | "SEV-4";
export type IncidentStatus = "investigating" | "mitigated" | "resolved";
export type IncidentStage = "detected" | "reproduced" | "root-cause-identified" | "patch-review";
export type VerificationStatus =
  | "running"
  | "verified"
  | "regressed"
  | "not-reproduced"
  | "inconclusive"
  | "cancelled"
  | "policy-denied";

export interface IncidentTimelineEvent {
  timestamp: string;
  title: string;
  detail: string;
}

export interface Incident {
  id: IncidentId;
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

export interface RecoveryReport {
  id: string;
  status: VerificationStatus;
  approvalRequired: true;
  facts: readonly string[];
  inferences: readonly string[];
  unknowns: readonly string[];
  evidenceIds?: readonly string[];
  verificationResultIds?: readonly string[];
  candidatePatchIds?: readonly string[];
  evidenceCitations?: readonly { evidenceId: string; locator: string; relation: string }[];
  hypotheses?: readonly { hypothesisId: string; statement: string }[];
  patches?: readonly { candidatePatchId: string; touchedPaths: readonly string[] }[];
  commands?: readonly { executionId: string; status: string }[];
  environmentFingerprint?: { snapshotId: string } | null;
  baselineResults?: readonly { verificationResultId: string; exitCode: number | null }[];
  patchedResults?: readonly { verificationResultId: string; exitCode: number | null }[];
  [key: string]: unknown;
}

export type ApprovalDecision = "approved" | "rejected";

export interface ApprovalState {
  status: "pending" | ApprovalDecision;
  requestedAt: string;
  decidedAt?: string;
  approverId?: string;
  note?: string;
}

export interface RecoveryReportRecord {
  report: RecoveryReport;
  approval: ApprovalState;
}

export interface ApprovalIntent {
  actorId: string;
  actorKind: "human";
  decision: ApprovalDecision;
  note?: string;
}

export class ApiClientError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
  }
}

const API_BASE_URL = (process.env.NEXT_PUBLIC_RIFT_API_URL ?? "").replace(/\/$/, "");

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    let code: string | undefined;
    try {
      const body = (await response.json()) as { error?: string; code?: string };
      if (body.error) message = body.error;
      code = body.code;
    } catch {
      // Keep the status-based message when the API response is not JSON.
    }
    throw new ApiClientError(message, response.status, code);
  }

  return (await response.json()) as T;
}

export function fetchIncidents(): Promise<Incident[]> {
  return request<Incident[]>("/api/incidents");
}

export function fetchIncident(id: string): Promise<Incident> {
  return request<Incident>(`/api/incidents/${encodeURIComponent(id)}`);
}

export async function fetchRecoveryReport(incidentId: string): Promise<RecoveryReportRecord | null> {
  try {
    return await request<RecoveryReportRecord>(`/api/incidents/${encodeURIComponent(incidentId)}/report`);
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404 && error.code === "REPORT_NOT_FOUND") return null;
    throw error;
  }
}

export function submitApprovalIntent(reportId: string, intent: ApprovalIntent): Promise<RecoveryReportRecord> {
  return request<RecoveryReportRecord>(`/api/reports/${encodeURIComponent(reportId)}/approval`, {
    method: "POST",
    headers: {
      "x-rift-actor": intent.actorId,
      "x-rift-actor-kind": "human",
    },
    body: JSON.stringify(intent),
  });
}

export function verificationStatusLabel(status: VerificationStatus): string {
  const labels: Record<VerificationStatus, string> = {
    running: "Running",
    verified: "Verified",
    regressed: "Regressed",
    "not-reproduced": "Not reproduced",
    inconclusive: "Inconclusive",
    cancelled: "Cancelled",
    "policy-denied": "Policy denied",
  };
  return labels[status];
}
