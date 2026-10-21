import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findIncident, demoIncidents, type Incident } from "./domain/incidents.js";
import type { IncidentManifest } from "./domain/contracts.js";
import { InMemoryEvidenceStore, LocalEvidenceStore } from "./domain/evidence-store.js";
import type { EvidenceStore } from "./domain/evidence-store.js";
import { intakeIncidentManifest, ManifestValidationError, MAX_MANIFEST_BYTES } from "./domain/intake.js";
import { findRecoveryData } from "./domain/recovery-data.js";
import { InMemoryReportStore, LocalReportStore, ReportStoreError } from "./report/store.js";
import { EvidenceBackedReportGenerator, ReportGenerationError } from "./report/generator.js";
import type { HumanApprovalRequest, ReportGenerationRequest, ReportStore } from "./report/ports.js";
import {
  createDemoRecoveryPipeline,
  createRecoveryPipeline,
  DemoPatchProvider,
  RecoveryPipelineError,
  type RecoveryPipelineDependencies,
  type RecoveryPipelineRequest,
  type RecoveryPipelineResult,
} from "./pipeline/index.js";
import { RepositorySnapshotReaderAdapter } from "./investigation/repository-snapshot.js";
import { BoundedCommandExecutor } from "./investigation/command-executor.js";
import { StagedDockerVerificationRunner } from "./verification/staged-docker-runner.js";
import type { VerificationAuditSink } from "./verification/ports.js";

const SERVICE_NAME = "rift-api";
const SERVICE_VERSION = "0.1.0";
const DEFAULT_PORT = 4000;
const DEMO_ALLOWED_PATHS = ["demo/src/domain/shop.ts"] as const;
const DEMO_ALLOWED_COMMANDS = ["node", "npm"] as const;
const DEMO_TARGET_PATHS = ["demo/src/domain/shop.ts"] as const;

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
  if (response.destroyed || response.writableEnded) return;
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

export interface RecoveryPipelineLike {
  run(request: RecoveryPipelineRequest): Promise<RecoveryPipelineResult>;
}

export interface RecoveryPipelineFactoryContext {
  readonly request: RecoveryPipelineRequest;
  readonly expectedBaselineFailure: RecoveryPipelineRequest["expectedBaselineFailure"];
  readonly evidenceStore: EvidenceStore;
  readonly reportStore: ReportStore;
  readonly demoRepositoryRoot: string;
}

export interface ApiServerOptions {
  readonly evidenceStore?: EvidenceStore;
  readonly reportStore?: ReportStore;
  /** Inject a complete pipeline composition for HTTP tests or a staged runner. */
  readonly pipelineFactory?: (context: RecoveryPipelineFactoryContext) => RecoveryPipelineLike;
  /** Convenience injection for callers that already assembled all pipeline ports. */
  readonly pipelineDependencies?: RecoveryPipelineDependencies;
  /** Server-owned source root; it is never read from a recovery request. */
  readonly demoRepositoryRoot?: string;
  /** Directory for the default append-only local evidence and report stores. */
  readonly dataDirectory?: string;
}

interface RecoveryArtifacts {
  readonly result: RecoveryPipelineResult;
  readonly incident: Incident;
}

interface ApiState {
  readonly evidenceStore: EvidenceStore;
  readonly reportStore: ReportStore;
  readonly options: ApiServerOptions;
  readonly demoRepositoryRoot: string;
  readonly dynamicIncidents: Map<string, Incident>;
  readonly artifacts: Map<string, RecoveryArtifacts>;
  readonly recoveryRuns: Map<string, RecoveryRunState>;
}

interface RecoveryRunState {
  readonly incidentId: string;
  readonly controller: AbortController;
  status: "running" | "completed" | "cancelled" | "failed";
}

class RecoveryRequestError extends Error {
  public constructor(public readonly code: string, message: string, public readonly statusCode = 400) { super(message); }
}

function recoveryRequest(body: unknown, incidentId: string, evidenceStore: EvidenceStore): { request: RecoveryPipelineRequest; expected: RecoveryPipelineRequest["expectedBaselineFailure"] } {
  if (!isRecord(body) || Object.keys(body).some((key) => !["manifest", "evidence", "expectedBaselineFailure"].includes(key))) {
    throw new RecoveryRequestError("RECOVERY_INPUT_INVALID", "Recovery request accepts manifest, evidence, and expectedBaselineFailure only");
  }
  if (!Array.isArray(body.evidence ?? [])) throw new RecoveryRequestError("RECOVERY_EVIDENCE_INVALID", "Recovery evidence must be an array");
  const expected = body.expectedBaselineFailure;
  if (!isRecord(expected) || Object.keys(expected).some((key) => !["code", "signature"].includes(key)) || typeof expected.code !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(expected.code) || typeof expected.signature !== "string" || !expected.signature.trim() || expected.signature.length > 512) {
    throw new RecoveryRequestError("EXPECTED_BASELINE_SIGNATURE_REQUIRED", "expectedBaselineFailure.code and .signature are required");
  }
  const intake = intakeIncidentManifest(body.manifest, evidenceStore, { actor: "local-recovery-request" });
  if (intake.manifest.incidentId !== incidentId) throw new RecoveryRequestError("INCIDENT_ID_MISMATCH", "Manifest incidentId must match the route incident id");
  // The manifest is descriptive input. Capability authority remains server-owned;
  // reject manifests that attempt to widen the demo fixture's scope or policy.
  if (intake.manifest.allowedPaths.some((path) => !DEMO_ALLOWED_PATHS.includes(path as typeof DEMO_ALLOWED_PATHS[number]))) {
    throw new RecoveryRequestError("DEMO_PATH_NOT_ALLOWED", "Recovery manifest paths must stay within the configured demo fixture");
  }
  if (intake.manifest.policy.networkAccess !== "disabled" || intake.manifest.policy.allowedCommands?.some((command) => !DEMO_ALLOWED_COMMANDS.includes(command as typeof DEMO_ALLOWED_COMMANDS[number]))) {
    throw new RecoveryRequestError("DEMO_POLICY_NOT_ALLOWED", "Recovery manifest must use the configured offline demo policy");
  }
  if ([intake.manifest.reproductionCommand, ...intake.manifest.testCommands].some((command) => !DEMO_ALLOWED_COMMANDS.includes(command.command as typeof DEMO_ALLOWED_COMMANDS[number]))) {
    throw new RecoveryRequestError("DEMO_COMMAND_NOT_ALLOWED", "Recovery commands must use the configured demo command set");
  }
  const expectedBaselineFailure = { code: expected.code, signature: expected.signature };
  return {
    expected: expectedBaselineFailure,
    request: {
      manifest: intake.manifest,
      evidence: body.evidence as readonly unknown[],
      expectedBaselineFailure,
      repositoryCapability: { repositoryRevision: intake.manifest.repositoryRevision, allowedPaths: DEMO_ALLOWED_PATHS },
      baselineCapability: { allowedCommands: DEMO_ALLOWED_COMMANDS, networkAccess: "disabled", timeoutMs: 30_000 },
      modelPolicy: { authorized: true, actor: "fake-model", allowedPaths: DEMO_ALLOWED_PATHS, targetPaths: DEMO_TARGET_PATHS },
    },
  };
}

function dynamicIncident(result: RecoveryPipelineResult): Incident {
  const now = result.manifest.createdAt;
  return {
    id: result.manifest.incidentId,
    severity: "SEV-3",
    status: "investigating",
    stage: result.verificationResults.length > 0 ? "patch-review" : "reproduced",
    title: `Recovery request ${result.manifest.incidentId}`,
    summary: "Local recovery investigation generated an evidence-backed report pending human approval.",
    service: result.manifest.repositoryRevision.repository,
    repository: result.manifest.repositoryRevision.repository,
    commit: result.manifest.repositoryRevision.revision,
    detectedAt: now,
    updatedAt: now,
    evidenceCount: result.reportRecord.report.evidenceIds.length,
    demo: true,
    timeline: [{ timestamp: now, title: "Recovery investigation completed", detail: "Candidate artifacts and a pending report are available for review." }],
  };
}

function buildPipeline(state: ApiState, request: RecoveryPipelineRequest, expected: RecoveryPipelineRequest["expectedBaselineFailure"]): RecoveryPipelineLike {
  const context: RecoveryPipelineFactoryContext = { request, expectedBaselineFailure: expected, evidenceStore: state.evidenceStore, reportStore: state.reportStore, demoRepositoryRoot: state.demoRepositoryRoot };
  if (state.options.pipelineFactory) return state.options.pipelineFactory(context);
  if (state.options.pipelineDependencies) return createRecoveryPipeline(state.options.pipelineDependencies);
  if (process.env.NODE_ENV === "test" || process.env.RIFT_MVP_MODE === "demo") {
    return createDemoRecoveryPipeline({ repositoryRoot: state.demoRepositoryRoot, evidenceStore: state.evidenceStore, reportStore: state.reportStore, expectedBaselineFailure: expected });
  }
  const image = process.env.RIFT_STAGED_DOCKER_IMAGE;
  if (!image) throw new RecoveryRequestError("STAGED_DOCKER_CONFIG_REQUIRED", "Recovery is disabled until a staged Docker composition is configured", 503);
  const manifest = request.manifest as IncidentManifest;
  const repository = process.env.RIFT_STAGED_DOCKER_REPOSITORY ?? manifest.repositoryRevision.repository;
  if (repository !== manifest.repositoryRevision.repository) throw new RecoveryRequestError("STAGED_DOCKER_REPOSITORY_MISMATCH", "The staged Docker repository does not match the recovery manifest", 503);
  const snapshotReader = new RepositorySnapshotReaderAdapter({ repositoryRoot: state.demoRepositoryRoot });
  const baselineExecutor = new BoundedCommandExecutor({ snapshotProvider: snapshotReader, containerImage: image });
  const verificationRunner = new StagedDockerVerificationRunner({ repositoryPath: state.demoRepositoryRoot, repository, image, evidenceStore: state.evidenceStore, expectedBaselineFailure: expected });
  const verificationAudit: VerificationAuditSink = { append: () => undefined };
  return createRecoveryPipeline({ evidenceStore: state.evidenceStore, reportStore: state.reportStore, snapshotReader, baselineExecutor, patchProvider: new DemoPatchProvider(state.demoRepositoryRoot), verificationRunner, verificationAudit });
}

function handleRequest(request: IncomingMessage, response: ServerResponse, state: ApiState): void {
  const { evidenceStore, reportStore } = state;
  const requestUrl = new URL(request.url ?? "/", "http://localhost");

  const recoveryStatusPath = requestUrl.pathname.match(/^\/api\/recovery\/([^/]+)$/u);
  if (request.method === "GET" && recoveryStatusPath) {
    const run = state.recoveryRuns.get(decodeURIComponent(recoveryStatusPath[1]));
    if (run === undefined) {
      sendJson(response, 404, { error: "Recovery run not found", code: "RECOVERY_RUN_NOT_FOUND" });
      return;
    }
    sendJson(response, 200, { runId: decodeURIComponent(recoveryStatusPath[1]), incidentId: run.incidentId, status: run.status });
    return;
  }

  const recoveryCancelPath = requestUrl.pathname.match(/^\/api\/recovery\/([^/]+)\/cancel$/u);
  const incidentRecoveryCancelPath = requestUrl.pathname.match(/^\/api\/incidents\/([^/]+)\/recovery\/([^/]+)\/cancel$/u);
  const incidentRecoveryStopPath = requestUrl.pathname.match(/^\/api\/incidents\/([^/]+)\/recovery\/(?:cancel|stop)$/u);
  const incidentRecoveryDeletePath = request.method === "DELETE" ? requestUrl.pathname.match(/^\/api\/incidents\/([^/]+)\/recovery$/u) : null;
  if ((request.method === "POST" || request.method === "DELETE") && (recoveryCancelPath || incidentRecoveryCancelPath || incidentRecoveryStopPath || incidentRecoveryDeletePath)) {
    const incidentId = incidentRecoveryCancelPath?.[1] ?? incidentRecoveryStopPath?.[1] ?? incidentRecoveryDeletePath?.[1];
    const explicitRunId = recoveryCancelPath?.[1] ?? incidentRecoveryCancelPath?.[2];
    const matchingRuns = incidentId === undefined ? [] : [...state.recoveryRuns.entries()].filter(([, candidate]) => candidate.incidentId === decodeURIComponent(incidentId) && candidate.status === "running");
    const runId = decodeURIComponent(explicitRunId ?? (matchingRuns.length === 1 ? matchingRuns[0][0] : ""));
    const run = state.recoveryRuns.get(runId);
    if (run === undefined || (incidentId !== undefined && run.incidentId !== decodeURIComponent(incidentId))) {
      sendJson(response, 404, { error: "Recovery run not found", code: "RECOVERY_RUN_NOT_FOUND" });
      return;
    }
    if (run.status === "running") {
      run.controller.abort("cancelled by HTTP caller");
      run.status = "cancelled";
    }
    sendJson(response, 202, { runId, incidentId: run.incidentId, status: "cancellation-requested" });
    return;
  }
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
  const recoveryPath = requestUrl.pathname.match(/^\/api\/incidents\/([^/]+)\/recovery$/u);
  if (request.method === "POST" && recoveryPath) {
    const incidentId = decodeURIComponent(recoveryPath[1]);
    const requestedRunId = request.headers["x-rift-recovery-run-id"];
    const runId = typeof requestedRunId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(requestedRunId) ? requestedRunId : randomUUID();
    const controller = new AbortController();
    const runState: RecoveryRunState = { incidentId, controller, status: "running" };
    state.recoveryRuns.set(runId, runState);
    request.once("aborted", () => controller.abort("HTTP request aborted"));
    void readJson(request).then((body) => {
      try {
        const parsed = recoveryRequest(body, incidentId, evidenceStore);
        const pipeline = buildPipeline(state, { ...parsed.request, signal: controller.signal }, parsed.expected);
        return pipeline.run({ ...parsed.request, signal: controller.signal }).then((result) => {
          runState.status = controller.signal.aborted ? "cancelled" : "completed";
          const incident = dynamicIncident(result);
          state.dynamicIncidents.set(incident.id, incident);
          state.artifacts.set(incident.id, { result, incident });
          sendJson(response, 201, {
            incident,
            manifest: result.manifest,
            hypothesisSet: result.hypothesisSet,
            patches: result.patchGeneration.candidatePatches,
            report: result.reportRecord,
            recoveryRunId: runId,
          });
        });
      } catch (error: unknown) {
        runState.status = controller.signal.aborted ? "cancelled" : "failed";
        if (error instanceof ManifestValidationError) {
          sendJson(response, error.statusCode, { error: "Recovery manifest rejected", code: error.errors[0]?.code, errors: error.errors });
        } else if (error instanceof RecoveryRequestError) {
          sendJson(response, error.statusCode, { error: error.message, code: error.code });
        } else {
          const code = error instanceof RecoveryPipelineError ? error.code : "RECOVERY_FAILED";
          sendJson(response, code === "CANCELLED" ? 409 : 422, { error: error instanceof Error ? error.message : "Recovery request failed", code, recoveryRunId: runId });
        }
      }
    }).catch((error: unknown) => {
      runState.status = controller.signal.aborted ? "cancelled" : "failed";
      if (error instanceof RecoveryRequestError) {
        sendJson(response, error.statusCode, { error: error.message, code: error.code });
        return;
      }
      const code = error instanceof Error && "code" in error ? String(error.code) : "RECOVERY_FAILED";
      sendJson(response, code === "BODY_TOO_LARGE" ? 413 : code === "MALFORMED_JSON" ? 400 : code === "CANCELLED" ? 409 : 422, { error: error instanceof Error ? error.message : "Recovery request failed", code, recoveryRunId: runId });
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
    const dynamic = [...state.dynamicIncidents.values()].filter((incident) => !demoIncidents.some((demo) => demo.id === incident.id));
    sendJson(response, 200, [...demoIncidents, ...dynamic]);
    return;
  }

  const hypothesesPath = requestUrl.pathname.match(/^\/api\/incidents\/([^/]+)\/hypotheses$/);
  if (hypothesesPath) {
    const incidentId = decodeURIComponent(hypothesesPath[1]);
    const incident = findIncident(incidentId) ?? state.dynamicIncidents.get(incidentId);
    if (!incident) {
      sendJson(response, 404, { error: "Incident not found", id: incidentId });
      return;
    }

    sendJson(response, 200, state.artifacts.get(incidentId)?.result.hypothesisSet ?? findRecoveryData(incidentId)?.hypothesisSet);
    return;
  }

  const patchesPath = requestUrl.pathname.match(/^\/api\/incidents\/([^/]+)\/patches$/);
  if (patchesPath) {
    const incidentId = decodeURIComponent(patchesPath[1]);
    const incident = findIncident(incidentId) ?? state.dynamicIncidents.get(incidentId);
    if (!incident) {
      sendJson(response, 404, { error: "Incident not found", id: incidentId });
      return;
    }

    sendJson(response, 200, state.artifacts.get(incidentId)?.result.patchGeneration.candidatePatches ?? findRecoveryData(incidentId)?.patches ?? []);
    return;
  }

  const incidentPath = requestUrl.pathname.match(/^\/api\/incidents\/([^/]+)$/);
  if (incidentPath) {
    const incidentId = decodeURIComponent(incidentPath[1]);
    const incident = findIncident(incidentId) ?? state.dynamicIncidents.get(incidentId);

    if (!incident) {
      sendJson(response, 404, { error: "Incident not found", id: incidentId });
      return;
    }

    sendJson(response, 200, incident);
    return;
  }

  sendJson(response, 404, { error: "Route not found" });
}

export function createApiServer(options: ApiServerOptions = {}): Server {
  const dataDirectory = options.dataDirectory ?? process.env.RIFT_DATA_DIR ?? join(process.cwd(), "reports");
  // Vitest compositions must remain isolated and deterministic. The live server
  // uses append-only JSONL stores, while callers can still inject either store.
  const evidenceStore = options.evidenceStore ?? (process.env.NODE_ENV === "test"
    ? new InMemoryEvidenceStore()
    : new LocalEvidenceStore(join(dataDirectory, "evidence.jsonl")));
  const reportStore = options.reportStore ?? (process.env.NODE_ENV === "test"
    ? new InMemoryReportStore()
    : new LocalReportStore(join(dataDirectory, "reports.jsonl")));
  const state: ApiState = {
    evidenceStore,
    reportStore,
    options,
    demoRepositoryRoot: options.demoRepositoryRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
    dynamicIncidents: new Map(),
    artifacts: new Map(),
    recoveryRuns: new Map(),
  };
  return createServer((request, response) => handleRequest(request, response, state));
}

function getPort(): number {
  const configuredPort = Number.parseInt(process.env.PORT ?? "", 10);
  return Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : DEFAULT_PORT;
}

function getHost(): string {
  return process.env.RIFT_HOST === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
}

export function startServer(): Server {
  const server = createApiServer();
  server.listen(getPort(), getHost(), () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : getPort();
    console.log(`${SERVICE_NAME} listening on port ${port}`);
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
