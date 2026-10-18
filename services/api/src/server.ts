import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { findIncident, demoIncidents } from "./domain/incidents.js";
import { InMemoryEvidenceStore } from "./domain/evidence-store.js";
import type { EvidenceStore } from "./domain/evidence-store.js";
import { intakeIncidentManifest, ManifestValidationError, MAX_MANIFEST_BYTES } from "./domain/intake.js";
import { findRecoveryData } from "./domain/recovery-data.js";

const SERVICE_NAME = "rift-api";
const SERVICE_VERSION = "0.1.0";
const DEFAULT_PORT = 4000;

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

function handleRequest(request: IncomingMessage, response: ServerResponse, evidenceStore: EvidenceStore): void {
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

  const hypothesesPath = requestUrl.pathname.match(/^\/api\/incidents\/([^/]+)\/hypotheses$/);
  if (hypothesesPath) {
    const incidentId = decodeURIComponent(hypothesesPath[1]);
    const incident = findIncident(incidentId);
    if (!incident) {
      sendJson(response, 404, { error: "Incident not found", id: incidentId });
      return;
    }

    sendJson(response, 200, findRecoveryData(incidentId)?.hypothesisSet);
    return;
  }

  const patchesPath = requestUrl.pathname.match(/^\/api\/incidents\/([^/]+)\/patches$/);
  if (patchesPath) {
    const incidentId = decodeURIComponent(patchesPath[1]);
    const incident = findIncident(incidentId);
    if (!incident) {
      sendJson(response, 404, { error: "Incident not found", id: incidentId });
      return;
    }

    sendJson(response, 200, { patches: findRecoveryData(incidentId)?.patches ?? [] });
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
}

export function createApiServer(options: ApiServerOptions = {}): Server {
  const evidenceStore = options.evidenceStore ?? new InMemoryEvidenceStore();
  return createServer((request, response) => handleRequest(request, response, evidenceStore));
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
