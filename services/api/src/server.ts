import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { findIncident, demoIncidents } from "./domain/incidents.js";

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

function handleRequest(request: IncomingMessage, response: ServerResponse): void {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const requestUrl = new URL(request.url ?? "/", "http://localhost");

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

export function createApiServer(): Server {
  return createServer(handleRequest);
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
