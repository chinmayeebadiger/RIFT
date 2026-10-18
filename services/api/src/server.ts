import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { findIncident, demoIncidents } from "./domain/incidents.js";
import { InMemoryEvidenceStore } from "./domain/evidence-store.js";
import type { EvidenceStore } from "./domain/evidence-store.js";
import { intakeIncidentManifest, ManifestValidationError, MAX_MANIFEST_BYTES } from "./domain/intake.js";
import { InMemoryReportStore, ReportStoreError } from "./report/store.js";
import { EvidenceBackedReportGenerator, ReportGenerationError } from "./report/generator.js";
import type { HumanApprovalRequest, ReportGenerationRequest, ReportStore } from "./report/ports.js";

const SERVICE_NAME = "rift-api";
const SERVICE_VERSION = "0.1.0";
const DEFAULT_PORT = 4000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface HealthResponse {
  service: string;
  status: "ok";
  version: string;
  timestamp: string;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const declared = Number.parseInt(request.headers["content-length"] ?? "", 10);
    if (Number.isFinite(declared) && declared > MAX_MANIFEST_BYTES) {
      request.resume();
      reject(Object.assign(new Error(`Request body exceeds ${MAX_MANIFEST_BYTES} bytes`), { code: "BODY_TOO_LARGE" }));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    request.on("data", (chunk: Buffer | string) => {
      if (done) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += data.byteLength;
      if (size > MAX_MANIFEST_BYTES) {
        done = true;
        request.resume();
        reject(Object.assign(new Error(`Request body exceeds ${MAX_MANIFEST_BYTES} bytes`), { code: "BODY_TOO_LARGE" }));
      } else chunks.push(data);
    });
    request.on("end", () => {
      if (done) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(Object.assign(new Error("Request body is not valid JSON"), { code: "MALFORMED_JSON" })); }
    });
    request.on("error", reject);
  });
}

function handleRequest(request: IncomingMessage, response: ServerResponse, evidenceStore: EvidenceStore, reportStore: ReportStore): void {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "POST" && requestUrl.pathname === "/api/incidents/intake") {
    void readJson(request).then((body) => {
      try {
        const denied = ["deny", "denied", "false"].includes(String(request.headers["x-rift-authorization"] ?? "").toLowerCase());
        const result = intakeIncidentManifest(body, evidenceStore, { authorized: !denied });
        sendJson(response, 201, result);
      } catch (error: unknown) {
        if (error instanceof ManifestValidationError) {
          sendJson(response, error.statusCode, { error: "Incident manifest rejected", code: error.errors[0]?.code, errors: error.errors });
        } else sendJson(response, 500, { error: "Incident manifest intake failed", code: "INTAKE_FAILED" });
      }
    }).catch((error: unknown) => {
      const code = error instanceof Error && "code" in error ? String(error.code) : "MALFORMED_JSON";
      sendJson(response, code === "BODY_TOO_LARGE" ? 413 : 400, { error: error instanceof Error ? error.message : "Malformed JSON request body", code, errors: [{ code, path: "$", message: error instanceof Error ? error.message : "Malformed JSON request body" }] });
    });
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/reports") {
    void readJson(request).then((body) => {
      try {
        if (!isRecord(body)) {
          sendJson(response, 400, { error: "Recovery report request must be an object", code: "REPORT_INPUT_INVALID" });
          return;
        }
        const record = new EvidenceBackedReportGenerator().generate(body as unknown as ReportGenerationRequest);
        const saved = reportStore.save(record);
        sendJson(response, 201, saved);
      } catch (error: unknown) {
        if (error instanceof ReportGenerationError) {
          const status = error.code === "REPORT_POLICY_DENIED" ? 403 : error.code === "REPORT_EVIDENCE_MISSING" ? 422 : 400;
          sendJson(response, status, { error: error.message, code: error.code });
          return;
        }
        if (error instanceof ReportStoreError) {
          sendJson(response, error.code === "REPORT_DUPLICATE" ? 409 : 400, { error: error.message, code: error.code });
          return;
        }
        sendJson(response, 500, { error: "Recovery report generation failed", code: "REPORT_GENERATION_FAILED" });
      }
    }).catch((error: unknown) => {
      const code = error instanceof Error && "code" in error ? String(error.code) : "MALFORMED_JSON";
      sendJson(response, code === "BODY_TOO_LARGE" ? 413 : 400, { error: error instanceof Error ? error.message : "Malformed JSON request body", code });
    });
    return;
  }
  const reportPath = requestUrl.pathname.match(/^\/api\/reports\/([^/]+)$/u);
  const incidentReportPath = requestUrl.pathname.match(/^\/api\/incidents\/([^/]+)\/reports\/([^/]+)$/u);
  const incidentReportsPath = requestUrl.pathname.match(/^\/api\/incidents\/([^/]+)\/reports$/u);
  const legacyIncidentReportPath = requestUrl.pathname.match(/^\/api\/incidents\/([^/]+)\/recovery-report$/u);
  const singularIncidentReportPath = requestUrl.pathname.match(/^\/api\/incidents\/([^/]+)\/report$/u);
  const approvalPath = requestUrl.pathname.match(/^\/api\/reports\/([^/]+)\/approval$/u);
  const incidentApprovalPath = requestUrl.pathname.match(/^\/api\/incidents\/([^/]+)\/reports\/([^/]+)\/approval$/u);
  const singularIncidentApprovalPath = requestUrl.pathname.match(/^\/api\/incidents\/([^/]+)\/report\/approval$/u);

  if (request.method === "POST" && (approvalPath || incidentApprovalPath || singularIncidentApprovalPath)) {
    const reportId = approvalPath?.[1] ?? incidentApprovalPath?.[2];
    const incidentId = incidentApprovalPath?.[1] ?? singularIncidentApprovalPath?.[1];
    const resolvedReportId = reportId ?? (incidentId === undefined ? undefined : reportStore.list({ incidentId: decodeURIComponent(incidentId) })[0]?.report.id);
    if (resolvedReportId === undefined) {
      sendJson(response, 400, { error: "Recovery report id is required", code: "REPORT_INVALID" });
      return;
    }
    void readJson(request).then((body) => {
      try {
        const record = reportStore.get(decodeURIComponent(resolvedReportId));
        if (record === undefined || (incidentId !== undefined && record.report.incidentId !== decodeURIComponent(incidentId))) {
          sendJson(response, 404, { error: "Recovery report not found", code: "REPORT_NOT_FOUND" });
          return;
        }
        if (!isRecord(body)) {
          sendJson(response, 400, { error: "Approval request must be an object", code: "APPROVAL_INVALID" });
          return;
        }
        const actorKind = request.headers["x-rift-actor-kind"] ?? (typeof body.actorKind === "string" ? body.actorKind : undefined);
        if (actorKind !== undefined && actorKind !== "human") {
          sendJson(response, 403, { error: "Only a human actor may record approval", code: "APPROVAL_POLICY_DENIED" });
          return;
        }
        if (body.note !== undefined && typeof body.note !== "string") {
          sendJson(response, 400, { error: "Approval note must be text", code: "APPROVAL_INVALID" });
          return;
        }
        const actorId = String(request.headers["x-rift-actor"] ?? body.actorId ?? "");
        const approval: HumanApprovalRequest = {
          actorId,
          actorKind: "human",
          decision: body.decision as HumanApprovalRequest["decision"],
           ...(body.note === undefined ? {} : { note: body.note }),
        };
        const updated = reportStore.recordApproval(decodeURIComponent(resolvedReportId), approval);
        sendJson(response, 200, updated);
      } catch (error: unknown) {
        if (error instanceof ReportStoreError) {
          const status = error.code === "REPORT_NOT_FOUND" ? 404 : error.code === "APPROVAL_ALREADY_DECIDED" ? 409 : error.code === "APPROVAL_POLICY_DENIED" ? 403 : 400;
          sendJson(response, status, { error: error.message, code: error.code });
          return;
        }
        sendJson(response, 500, { error: "Approval recording failed", code: "APPROVAL_FAILED" });
      }
    }).catch((error: unknown) => {
      const code = error instanceof Error && "code" in error ? String(error.code) : "MALFORMED_JSON";
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Malformed JSON request body", code });
    });
    return;
  }

  if (request.method === "GET" && (reportPath || incidentReportPath || incidentReportsPath || legacyIncidentReportPath || singularIncidentReportPath || requestUrl.pathname === "/api/reports")) {
    const reportId = reportPath?.[1] ?? incidentReportPath?.[2];
    const incidentId = incidentReportPath?.[1] ?? incidentReportsPath?.[1] ?? legacyIncidentReportPath?.[1] ?? singularIncidentReportPath?.[1] ?? requestUrl.searchParams.get("incidentId") ?? undefined;
    if (reportId === undefined && (incidentReportsPath !== null || requestUrl.pathname === "/api/reports")) {
      sendJson(response, 200, reportStore.list(incidentId === undefined ? {} : { incidentId: decodeURIComponent(incidentId) }));
      return;
    }
    const record = reportId === undefined
      ? reportStore.list({ incidentId: decodeURIComponent(incidentId ?? "") })[0]
      : reportStore.get(decodeURIComponent(reportId));
    if (record === undefined || (incidentId !== undefined && record.report.incidentId !== decodeURIComponent(incidentId))) {
      sendJson(response, 404, { error: "Recovery report not found", code: "REPORT_NOT_FOUND" });
      return;
    }
    sendJson(response, 200, record);
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  if (requestUrl.pathname === "/health") {
    const body: HealthResponse = {
      service: SERVICE_NAME,
      status: "ok",
      version: SERVICE_VERSION,
      timestamp: new Date().toISOString(),
    };
    sendJson(response, 200, body);
    return;
  }

  if (requestUrl.pathname === "/api/incidents") {
    sendJson(response, 200, demoIncidents);
    return;
  }

  const incidentPath = requestUrl.pathname.match(/^\/api\/incidents\/([^/]+)$/);
  if (incidentPath) {
    const incidentId = decodeURIComponent(incidentPath[1]);
    const incident = findIncident(incidentId);

    if (!incident) {
      sendJson(response, 404, { error: "Incident not found", id: incidentId });
      return;
    }

    sendJson(response, 200, incident);
    return;
  }

  sendJson(response, 404, { error: "Route not found" });
}

export interface ApiServerOptions {
  readonly evidenceStore?: EvidenceStore;
  readonly reportStore?: ReportStore;
}

export function createApiServer(options: ApiServerOptions = {}): Server {
  const evidenceStore = options.evidenceStore ?? new InMemoryEvidenceStore();
  const reportStore = options.reportStore ?? new InMemoryReportStore();
  return createServer((request, response) => handleRequest(request, response, evidenceStore, reportStore));
}

function getPort(): number {
  const configuredPort = Number.parseInt(process.env.PORT ?? "", 10);
  return Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : DEFAULT_PORT;
}

export function startServer(): Server {
  const server = createApiServer();
  server.listen(getPort(), () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : getPort();
    console.log(`${SERVICE_NAME} listening on port ${port}`);
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
