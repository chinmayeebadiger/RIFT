import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type {
  CandidatePatch, CommandExecution, EvidenceCitation, EvidenceItem, HypothesisSet,
  IncidentManifest, InvestigationResult, InvestigationTimeline, JsonValue, LogNormalization,
  PatchGenerationResponse, RepositorySnapshot, ValidationResult, VerificationPlan, VerificationResult,
  VersionedContract,
} from "@rift/core";
import {
  validateCandidatePatch, validateCommandExecution, validateEvidenceItem, validateHypothesisSet,
  validateIncidentManifest, validateInvestigationResult, validateRecoveryReport,
  validateRepositorySnapshot, validateVerificationPlan, validateVerificationResult,
} from "@rift/core";
import type { EvidenceStore } from "../domain/evidence-store.js";
import { canonicalJson, sha256, withEvidenceHash } from "../domain/hashing.js";
import { generateHypothesisSet as generateHypotheses } from "../domain/hypothesis-engine.js";
import { intakeIncidentManifest } from "../domain/intake.js";
import {
  buildDeterministicTimeline, extractFailureSignature, normalizeLogEvidence, normalizeStackTraceEvidence,
} from "../domain/normalization.js";
import type { EvidenceCitation as SpecialistCitation } from "../domain/normalization.js";
import { rankCandidatePatches } from "../investigation/candidate-patch-ranker.js";
import type { CommandExecutor, CommandExecutionCapability, RepositoryReadCapability, RepositorySnapshotReader } from "../investigation/ports.js";
import type { CommandOutput } from "../investigation/command-executor.js";
import { BoundedCandidatePatchAdapter } from "../model-adapter/adapter.js";
import type { CandidatePatchProvider, ModelAdapterOptions } from "../model-adapter/types.js";
import { EvidenceBackedReportGenerator } from "../report/generator.js";
import type { RecoveryReportRecord, ReportStore } from "../report/ports.js";
import { BoundedVerificationConcurrency, VerificationOrchestrator, verificationIdempotencyKey } from "../verification/orchestrator.js";
import type { CommandOutcome, VerificationAuditSink, VerificationRunner, VerificationWorkspace } from "../verification/ports.js";

/**
 * Explicitly local-only composition used by the API's demo mode and tests.
 * It reads one server-owned demo file and records deterministic fixture output;
 * it never accepts a repository path, image, command allowlist, or actor from a
 * recovery request.
 */
export interface DemoRecoveryPipelineOptions {
  readonly repositoryRoot: string;
  readonly evidenceStore: EvidenceStore;
  readonly reportStore: ReportStore;
  readonly expectedBaselineFailure: { readonly code: string; readonly signature: string };
  readonly clock?: () => string;
}

function byteHash(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function fixtureEvidence(store: EvidenceStore, manifest: IncidentManifest, id: string, content: JsonValue, source: string, clock: () => string): string {
  const timestamp = clock();
  const body = {
    schemaVersion: 1 as const,
    kind: "EvidenceItem" as const,
    id,
    incidentId: manifest.incidentId,
    correlationId: manifest.correlationId,
    createdAt: timestamp,
    capturedAt: timestamp,
    content,
    source: { type: source, locator: `demo-fixture:${id}` },
    redaction: { status: "not-required" as const },
    provenance: { actor: "demo-fixture-runner", tool: "in-process-fixture" },
  };
  const item = { ...body, contentHash: sha256(body as unknown as JsonValue) };
  return store.append(item).id;
}

class DemoSnapshotReader implements RepositorySnapshotReader {
  public constructor(private readonly options: Pick<DemoRecoveryPipelineOptions, "repositoryRoot" | "clock">) {}

  public async read(request: Parameters<RepositorySnapshotReader["read"]>[0]): Promise<unknown> {
    const sourcePath = join(this.options.repositoryRoot, "demo/src/domain/shop.ts");
    const content = await readFile(sourcePath);
    const files = [{ path: "demo/src/domain/shop.ts", contentHash: byteHash(content), byteLength: content.byteLength }];
    const body = {
      schemaVersion: 1 as const,
      id: `demo-snapshot-${sha256({ repositoryRevision: request.repositoryRevision, files } as unknown as JsonValue).slice(7, 39)}`,
      incidentId: request.incidentId,
      correlationId: request.correlationId,
      createdAt: this.options.clock?.() ?? new Date().toISOString(),
      kind: "RepositorySnapshot" as const,
      repositoryRevision: request.repositoryRevision,
      files,
      adapter: { name: "rift-demo-fixture", version: "1" },
    };
    return { ...body, contentHash: sha256(body as unknown as JsonValue) };
  }
}

class DemoBaselineExecutor implements BaselineReproductionExecutor {
  private readonly outputs = new Map<string, CommandOutput>();
  public constructor(private readonly store: EvidenceStore, private readonly expected: DemoRecoveryPipelineOptions["expectedBaselineFailure"], private readonly clock: () => string) {}

  public async execute(request: Parameters<BaselineReproductionExecutor["execute"]>[0]): Promise<CommandExecution> {
    const startedAt = this.clock();
    const stdout = `signature=${this.expected.code} status=1 message="${this.expected.signature}"`;
    const body = {
      schemaVersion: 1 as const,
      kind: "CommandExecution" as const,
      id: `demo-baseline-${request.correlationId}`,
      incidentId: request.incidentId,
      correlationId: request.correlationId,
      createdAt: startedAt,
      snapshotId: request.snapshotId,
      command: { ...request.command, args: [...(request.command.args ?? [])] },
      status: "failed" as const,
      exitCode: 1,
      startedAt,
      finishedAt: startedAt,
      evidenceIds: [] as string[],
      failure: { code: this.expected.code, message: "Demo fixture baseline failure" },
    };
    const execution = { ...body, contentHash: sha256(body as unknown as JsonValue) } as CommandExecution;
    this.outputs.set(execution.id, { stdout, stderr: "" });
    return execution;
  }

  public getOutput(executionId: string): CommandOutput | undefined { return this.outputs.get(executionId); }
}

class DemoVerificationRunner implements VerificationRunner {
  private sequence = 0;
  private readonly manifests = new Map<string, IncidentManifest>();
  public constructor(private readonly store: EvidenceStore, private readonly expected: DemoRecoveryPipelineOptions["expectedBaselineFailure"], private readonly clock: () => string) {}

  public async createWorkspace(request: Parameters<VerificationRunner["createWorkspace"]>[0]): Promise<VerificationWorkspace> {
    this.manifests.set(request.runId, request.manifest);
    return { id: `demo-workspace-${request.runId}-${request.phase}`, phase: request.phase };
  }

  public async runBaseline(request: Parameters<VerificationRunner["runBaseline"]>[0]): Promise<CommandOutcome> {
    const evidenceIds = [fixtureEvidence(this.store, request.manifest, `demo-verification-baseline-${request.runId}`, `demo baseline: ${this.expected.signature}`, "demo-fixture-baseline", this.clock)];
    return { status: "failed", exitCode: 1, reproduced: true, failureCode: this.expected.code, evidenceIds };
  }

  public async applyPatch(request: Parameters<VerificationRunner["applyPatch"]>[0]): Promise<{ applied: boolean; receiptId: string; evidenceIds: string[] }> {
    const id = `demo-patch-application-${request.runId}`;
    const manifest = this.manifest(request.runId);
    const evidenceIds = [fixtureEvidence(this.store, manifest, id, "demo patch application recorded", "demo-fixture-patch", this.clock)];
    return { applied: true, receiptId: id, evidenceIds };
  }

  public async runChecks(request: Parameters<VerificationRunner["runChecks"]>[0]): Promise<{ executions: CommandOutcome[] }> {
    const manifest = this.manifest(request.runId);
    return { executions: request.plan.verificationCommands.map((_, index) => ({
      status: "succeeded" as const,
      exitCode: 0,
      evidenceIds: [fixtureEvidence(this.store, manifest, `demo-check-${request.workspace.id}-${this.sequence++}-${index}`, "demo verification passed", "demo-fixture-check", this.clock)],
    })) };
  }

  public async cleanup(request: Parameters<VerificationRunner["cleanup"]>[0]): Promise<{ cleaned: true }> { this.manifests.delete(request.runId); return { cleaned: true }; }
  private manifest(runId: string): IncidentManifest {
    const manifest = this.manifests.get(runId);
    if (!manifest) throw new RecoveryPipelineError("DEMO_RUN_CONTEXT_MISSING");
    return manifest;
  }
}

export class DemoPatchProvider implements CandidatePatchProvider {
  public readonly name = "demo-fixture-model";
  public constructor(private readonly repositoryRoot: string) {}

  public async generate(input: string, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new DOMException("The demo fixture model was cancelled", "AbortError");
    const modelInput = JSON.parse(input) as { incidentId: string; correlationId: string; createdAt: string; repositoryRevision: { repository: string; revision: string }; hypothesisId: string; targetPath: string };
    // Keep the local MVP proposal deterministic and contract-valid even when the
    // optional integration fixture is absent or changes independently. The demo
    // runner records this candidate; it never applies it to the server checkout.
    const diff = [
      "diff --git a/demo/src/domain/shop.ts b/demo/src/domain/shop.ts",
      "--- a/demo/src/domain/shop.ts",
      "+++ b/demo/src/domain/shop.ts",
      "@@ -1 +1 @@",
      "-export interface Product {",
      "+export interface ProductRecord {",
      "",
    ].join("\n");
    const body = {
      kind: "CandidatePatch" as const,
      schemaVersion: 1 as const,
      id: `demo-patch-${modelInput.correlationId}`,
      incidentId: modelInput.incidentId,
      correlationId: modelInput.correlationId,
      createdAt: modelInput.createdAt,
      sourceHypothesisId: modelInput.hypothesisId,
      baseRevision: modelInput.repositoryRevision,
      diff,
      touchedPaths: ["demo/src/domain/shop.ts"],
      rationale: "Apply the reviewed deterministic demo repair in an isolated fixture workspace.",
      expectedInvariant: "The configured demo baseline failure is no longer reproduced.",
      generatedBy: { actor: "fake-model" as const, model: "rift-demo-fixture-v1" },
    };
    return JSON.stringify({ ...body, contentHash: sha256(body as unknown as JsonValue) });
  }
}

class NoopAudit implements VerificationAuditSink {
  public append(): void { /* local MVP audit is represented by evidence records */ }
}

export function createDemoRecoveryPipeline(options: DemoRecoveryPipelineOptions): RecoveryPipeline {
  const clock = options.clock ?? (() => new Date().toISOString());
  const snapshotReader = new DemoSnapshotReader(options);
  const baselineExecutor = new DemoBaselineExecutor(options.evidenceStore, options.expectedBaselineFailure, clock);
  const verificationRunner = new DemoVerificationRunner(options.evidenceStore, options.expectedBaselineFailure, clock);
  return new RecoveryPipeline({
    evidenceStore: options.evidenceStore,
    reportStore: options.reportStore,
    snapshotReader,
    baselineExecutor,
    patchProvider: new DemoPatchProvider(options.repositoryRoot),
    verificationRunner,
    verificationAudit: new NoopAudit(),
    clock,
  });
}

/** Existing executors may expose captured output separately from their core contract. */
export interface BaselineReproductionExecutor extends CommandExecutor {
  getOutput?(executionId: string): CommandOutput | undefined;
}

export interface RecoveryPipelineDependencies {
  readonly evidenceStore: EvidenceStore;
  readonly reportStore: ReportStore;
  /** Bind RepositorySnapshotReaderAdapter to an explicitly authorized repository root. */
  readonly snapshotReader: RepositorySnapshotReader & { dispose?(snapshotId: string): Promise<void> };
  readonly baselineExecutor: BaselineReproductionExecutor;
  readonly patchProvider: CandidatePatchProvider;
  /** Production composition should inject StagedDockerVerificationRunner. */
  readonly verificationRunner: VerificationRunner;
  readonly verificationAudit: VerificationAuditSink;
  readonly modelBounds?: ModelAdapterOptions;
  readonly clock?: () => string;
}

export interface RecoveryPipelineRequest {
  readonly manifest: unknown;
  readonly repositoryCapability: RepositoryReadCapability;
  readonly baselineCapability: CommandExecutionCapability;
  readonly expectedBaselineFailure: { readonly code: string; readonly signature: string };
  readonly modelPolicy: {
    readonly authorized: boolean;
    readonly actor: "fake-model" | "gpt-6-astra";
    /** Narrow patch scope separately from the broader read/test capability. */
    readonly allowedPaths: readonly string[];
    readonly targetPaths: readonly string[];
    readonly maxDiffBytes?: number;
  };
  readonly evidence?: readonly unknown[];
  readonly verificationTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface RecoveryPipelineResult {
  readonly manifest: IncidentManifest;
  readonly snapshot: RepositorySnapshot;
  readonly baseline: CommandExecution;
  readonly reproduced: boolean;
  readonly normalization: LogNormalization;
  readonly timeline: InvestigationTimeline;
  readonly hypothesisSet: HypothesisSet;
  readonly investigation: InvestigationResult;
  readonly patchGeneration: PatchGenerationResponse;
  readonly verificationPlans: readonly VerificationPlan[];
  readonly verificationResults: readonly VerificationResult[];
  readonly reportRecord: RecoveryReportRecord;
}

export class RecoveryPipelineError extends Error {
  public constructor(public readonly code: string, message = code) { super(message); this.name = "RecoveryPipelineError"; }
}

function hashContract<T extends object>(body: T): T & { readonly contentHash: string } {
  return { ...body, contentHash: sha256(body as unknown as JsonValue) };
}
function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left as JsonValue) === canonicalJson(right as JsonValue);
}
function within(path: string, scopes: readonly string[]): boolean {
  return scopes.some((scope) => path === scope || path.startsWith(`${scope}/`));
}
function safePaths(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 128 && new Set(value).size === value.length
    && value.every((path) => typeof path === "string" && path.length <= 512 && !path.startsWith("/") && !/[\\\u0000-\u001f\u007f]/u.test(path)
      && path.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."));
}
function checked<T extends VersionedContract>(result: ValidationResult<T>, context?: Pick<IncidentManifest, "incidentId" | "correlationId">): T {
  if (!result.ok) throw new RecoveryPipelineError("INVALID_CONTRACT", result.issues.map((issue) => `${issue.path}:${issue.code}`).join(","));
  const value = result.value;
  const { contentHash, ...body } = value;
  if (contentHash !== sha256(body as unknown as JsonValue)) throw new RecoveryPipelineError("CONTENT_HASH_MISMATCH");
  if (context && (value.incidentId !== context.incidentId || value.correlationId !== context.correlationId)) throw new RecoveryPipelineError("CONTEXT_MISMATCH");
  return value;
}

/**
 * Application composition, with no implicit repository, shell, model, or deploy authority.
 * All writes are append-only evidence plus a pending report. Patch application belongs
 * exclusively to the injected disposable VerificationRunner, never the caller's checkout.
 */
export class RecoveryPipeline {
  private readonly model: BoundedCandidatePatchAdapter;
  private readonly orchestrator: VerificationOrchestrator;
  private readonly reporter = new EvidenceBackedReportGenerator();

  public constructor(private readonly dependencies: RecoveryPipelineDependencies) {
    this.model = new BoundedCandidatePatchAdapter(dependencies.patchProvider, dependencies.modelBounds);
    this.orchestrator = new VerificationOrchestrator(
      this.checkedRunner(dependencies.verificationRunner), dependencies.verificationAudit,
      new BoundedVerificationConcurrency(1), undefined, 5_000, 1,
    );
  }

  public async run(request: RecoveryPipelineRequest): Promise<RecoveryPipelineResult> {
    this.assertRequest(request);
    const { manifest } = intakeIncidentManifest(request.manifest, this.dependencies.evidenceStore, { actor: "recovery-pipeline" });
    checked(validateIncidentManifest(manifest));
    this.validateCapabilities(request, manifest);
    const context = { incidentId: manifest.incidentId, correlationId: manifest.correlationId };
    const metadata = (kind: string) => ({ schemaVersion: 1 as const, ...context, createdAt: this.now(), id: `${kind}-${manifest.correlationId}` });
    for (const input of request.evidence ?? []) {
      const item = checked(validateEvidenceItem(input), manifest);
      if (!manifest.logSources.some((source) => source.locator === item.source.locator && source.type === item.source.type && (source.contentHash === undefined || source.contentHash === item.contentHash))) {
        throw new RecoveryPipelineError("UNDECLARED_LOG_SOURCE");
      }
      this.dependencies.evidenceStore.append(item);
    }
    const snapshotOutput = await this.dependencies.snapshotReader.read({
      ...context, repositoryRevision: manifest.repositoryRevision, capability: request.repositoryCapability, signal: request.signal,
    });
    try {
      const snapshot = checked(validateRepositorySnapshot(snapshotOutput), manifest);
      if (!same(snapshot.repositoryRevision, manifest.repositoryRevision) || snapshot.files.some((file) => !within(file.path, request.repositoryCapability.allowedPaths))) throw new RecoveryPipelineError("SNAPSHOT_SCOPE_MISMATCH");
      this.persist(snapshot, manifest);
      let baseline = checked(validateCommandExecution(await this.dependencies.baselineExecutor.execute({
        ...context, snapshotId: snapshot.id, command: manifest.reproductionCommand, capability: request.baselineCapability, signal: request.signal,
      })), manifest);
      if (baseline.snapshotId !== snapshot.id || !same(baseline.command, manifest.reproductionCommand)) throw new RecoveryPipelineError("BASELINE_CONTEXT_MISMATCH");
      if ((baseline.status === "succeeded" && baseline.exitCode !== 0) || (baseline.status === "failed" && baseline.exitCode === 0)) throw new RecoveryPipelineError("INCONSISTENT_BASELINE_EXIT");
      const output = this.dependencies.baselineExecutor.getOutput?.(baseline.id);
      if (output !== undefined) {
        if (typeof output.stdout !== "string" || typeof output.stderr !== "string") throw new RecoveryPipelineError("INVALID_BASELINE_OUTPUT");
        const stdout = this.append(manifest, `${baseline.id}-stdout`, output.stdout, "command-stdout", `execution:${baseline.id}:stdout`);
        const stderr = this.append(manifest, `${baseline.id}-stderr`, output.stderr, "command-stderr", `execution:${baseline.id}:stderr`);
        const { contentHash: _hash, ...body } = baseline;
        baseline = checked(validateCommandExecution(hashContract({ ...body, stdoutEvidenceId: stdout.id, stderrEvidenceId: stderr.id, evidenceIds: [...new Set([...baseline.evidenceIds, stdout.id, stderr.id])] })), manifest);
      }
      const baselineEvidence = this.resolveEvidence(baseline.evidenceIds, manifest);
      if (baselineEvidence.length === 0 || [baseline.stdoutEvidenceId, baseline.stderrEvidenceId].some((id) => id !== undefined && !baseline.evidenceIds.includes(id))) throw new RecoveryPipelineError("MISSING_BASELINE_EVIDENCE");
      this.persist(baseline, manifest);
      const reproduced = baseline.status === "failed" && baseline.exitCode !== null && baseline.exitCode !== 0 && this.matchesSignature(baselineEvidence, request.expectedBaselineFailure.signature);
      const imported = (request.evidence ?? []).map((value) => checked(validateEvidenceItem(value), manifest));
      const observations = [...imported, ...baselineEvidence].filter((item) => typeof item.content === "string");
      const specialized = observations.map((item) => item.source.type === "stack-trace" ? normalizeStackTraceEvidence(item) : normalizeLogEvidence(item));
      // Translate specialist line/frame/citation names to the shared persisted contracts.
      const normalization: LogNormalization = hashContract({
        ...metadata("normalization"), kind: "LogNormalization", inputEvidenceIds: observations.map((item) => item.id),
        records: specialized.flatMap((artifact) => artifact.lines.map((line) => ({
          ...(line.timestamp === undefined ? {} : { occurredAt: line.timestamp }), level: "unknown" as const,
          message: line.text.slice(0, 512), sourceEvidenceId: line.sourceEvidenceId,
          sourceLineStart: line.lineNumber, sourceLineEnd: line.lineNumber,
          ...("frames" in artifact ? { stackTrace: { frames: Object.values((artifact as ReturnType<typeof normalizeStackTraceEvidence>).frames).map((frame) => ({ file: frame.file, line: frame.line, column: frame.column, ...(frame.functionName === undefined ? {} : { function: frame.functionName }) })) } } : {}),
        }))).slice(0, 128), normalizer: { name: "rift-normalization-to-core", version: "1" },
      });
      const translateCitation = (citation: SpecialistCitation): EvidenceCitation => ({
        evidenceId: citation.evidenceId, evidenceHash: citation.contentHash, relation: "context",
        locator: `${citation.source.locator}${citation.lineStart === undefined ? "" : `#L${citation.lineStart}-L${citation.lineEnd ?? citation.lineStart}`}`,
      });
      const timeline: InvestigationTimeline = hashContract({
        ...metadata("timeline"), kind: "InvestigationTimeline", timeWindow: manifest.timeWindow,
        events: buildDeterministicTimeline(specialized).slice(0, 128).map((entry, index) => ({
          sequence: index + 1, ...(entry.timestamp === null ? {} : { occurredAt: entry.timestamp }),
          kind: "observation" as const, certainty: "observed" as const, summary: entry.detail.slice(0, 512),
          citations: entry.citations.map(translateCitation),
        })),
      });
      this.persist(normalization, manifest);
      this.persist(timeline, manifest);
      const signatures = specialized.flatMap((artifact) => {
        const signature = extractFailureSignature(artifact);
        return signature ? [{ name: signature.name, status: signature.status ?? "error", message: signature.message ?? signature.name, evidenceIds: signature.citations.map((citation) => citation.evidenceId) }] : [];
      });
      const hypothesisSet = checked(validateHypothesisSet(generateHypotheses({
        ...context, createdAt: this.now(), evidence: observations, failureSignatures: signatures, maxHypotheses: 8,
      })), manifest);
      const citation = (id: string, relation: EvidenceCitation["relation"]): EvidenceCitation => {
        const evidence = this.resolveEvidence([id], manifest)[0];
        return { evidenceId: id, evidenceHash: evidence.contentHash, relation, locator: evidence.source.locator };
      };
      const hypothesisEvidence = hypothesisSet.hypotheses.map((hypothesis) => {
        checked({ ok: true, value: hypothesis }, manifest);
        return { hypothesisId: hypothesis.id, citations: [
          ...hypothesis.supportingEvidenceIds.map((id) => citation(id, "supports")),
          ...hypothesis.contradictingEvidenceIds.map((id) => citation(id, "contradicts")),
        ] };
      });
      this.persist(hypothesisSet, manifest);
      const investigation = checked(validateInvestigationResult(hashContract({
        ...metadata("investigation"), kind: "InvestigationResult", snapshotId: snapshot.id,
        commandExecutionIds: [baseline.id], logNormalizationIds: [normalization.id], timelineId: timeline.id,
        hypothesisSetId: hypothesisSet.id, hypothesisEvidence, evidenceIds: [...new Set([ ...observations.map((item) => item.id), ...baseline.evidenceIds ])],
        status: reproduced ? "completed" : "inconclusive",
        facts: [`Baseline command exited with ${String(baseline.exitCode)}.`, reproduced ? "The expected failure signature was reproduced before patch proposal." : "The expected baseline failure was not reproduced; model proposal and verification were skipped."],
        inferences: hypothesisSet.hypotheses.map((hypothesis) => hypothesis.statement),
        unknowns: ["Disposable verification does not establish production behavior or authorize deployment."],
      })), manifest);
      this.persist(investigation, manifest);

      const candidates: CandidatePatch[] = [];
      const sourceHypothesis = hypothesisSet.hypotheses.find((hypothesis) => hypothesis.status !== "rejected" && hypothesis.contradictingEvidenceIds.length === 0 && hypothesis.supportingEvidenceIds.length > 0);
      if (reproduced && sourceHypothesis) {
        for (const targetPath of request.modelPolicy.targetPaths) {
          if (request.signal?.aborted) throw new RecoveryPipelineError("CANCELLED");
          const modelInput = { schemaVersion: 1 as const, ...context, createdAt: this.now(), repositoryRevision: manifest.repositoryRevision, hypothesisId: sourceHypothesis.id, hypothesisSummary: sourceHypothesis.statement, targetPath };
          const patch = checked(validateCandidatePatch(await this.model.propose({
            modelInput: { ...modelInput, inputHash: sha256(modelInput as unknown as JsonValue) },
            policy: { authorized: request.modelPolicy.authorized, incidentId: manifest.incidentId, repositoryRevision: manifest.repositoryRevision, hypothesisId: sourceHypothesis.id, allowedPaths: request.modelPolicy.allowedPaths, actor: request.modelPolicy.actor, maxDiffBytes: request.modelPolicy.maxDiffBytes ?? 65_536, maxTouchedPaths: 8 },
            signal: request.signal,
          }), { allowedPaths: request.modelPolicy.allowedPaths }), manifest);
          if (candidates.some((candidate) => candidate.id === patch.id)) throw new RecoveryPipelineError("DUPLICATE_CANDIDATE");
          candidates.push(patch);
          this.persist(patch, manifest);
        }
      }
      const ranking = rankCandidatePatches({ candidates, hypotheses: hypothesisSet.hypotheses, evidence: this.evidence(manifest), hypothesisEvidence, allowedPaths: request.modelPolicy.allowedPaths, repositoryRevision: manifest.repositoryRevision, reproductionCommand: manifest.reproductionCommand });
      const patchGeneration: PatchGenerationResponse = hashContract({
        ...metadata("patch-generation"), kind: "PatchGenerationResponse", hypothesisSetId: hypothesisSet.id,
        candidatePatches: ranking.accepted.map((entry) => entry.patch),
        ranking: { method: "evidence-scoped-ranking-v1", entries: ranking.accepted.map((entry) => ({ candidatePatchId: entry.patch.id, rank: entry.rank, score: entry.scores.total, rationale: "Evidence support, confidence, invariant specificity, scope and reproduction relevance." })) },
        status: ranking.accepted.length ? "generated" : "inconclusive", validationIssues: [],
      });
      this.persist(patchGeneration, manifest);
      const verificationPlans: VerificationPlan[] = [];
      const verificationResults: VerificationResult[] = [];
      // Verify the highest-ranked accepted candidate. Further attempts require a new run.
      const selected = ranking.accepted[0]?.patch;
      if (reproduced && selected) {
        const plan = checked(validateVerificationPlan(hashContract({
          ...metadata("verification-plan"), kind: "VerificationPlan", candidatePatchId: selected.id,
          baseRevision: manifest.repositoryRevision, baselineCommand: manifest.reproductionCommand,
          verificationCommands: [manifest.reproductionCommand, ...manifest.testCommands], timeoutMs: request.verificationTimeoutMs ?? request.baselineCapability.timeoutMs,
          networkAccess: request.baselineCapability.networkAccess,
        })), manifest);
        verificationPlans.push(plan);
        this.persist(plan, manifest);
        this.expectations.set(plan.id, request.expectedBaselineFailure);
        try {
          const input = { manifest, patch: selected, plan, correlationId: manifest.correlationId };
          const result = checked(validateVerificationResult(await this.orchestrator.start({ ...input,
            idempotencyKey: verificationIdempotencyKey(input), baselineExpectation: { expectedFailureCode: request.expectedBaselineFailure.code }, signal: request.signal,
          }).result), manifest);
          this.resolveEvidence(result.evidenceIds, manifest);
          verificationResults.push(result);
          this.persist(result, manifest);
        } finally { this.expectations.delete(plan.id); }
      }
      // Validate every evidence record, including records written by injected workers.
      if (request.signal?.aborted) throw new RecoveryPipelineError("CANCELLED");
      const evidence = this.evidence(manifest);
      const generated = this.reporter.generate({ ...context, investigationResult: investigation,
        candidatePatches: patchGeneration.candidatePatches, verificationResults, verificationPlans,
        snapshot, commandExecutions: [baseline], hypotheses: hypothesisSet.hypotheses, evidence,
        policy: { approvalRequired: true, networkAccess: request.baselineCapability.networkAccess },
        verificationStatus: reproduced ? "inconclusive" : "not-reproduced", now: this.now(),
      });
      checked(validateRecoveryReport(generated.report), manifest);
      if (generated.approval.status !== "pending") throw new RecoveryPipelineError("APPROVAL_MUST_REMAIN_PENDING");
      if (request.signal?.aborted) throw new RecoveryPipelineError("CANCELLED");
      this.persist(generated.report, manifest);
      const reportRecord = this.dependencies.reportStore.save(generated);
      return { manifest, snapshot, baseline, reproduced, normalization, timeline, hypothesisSet, investigation, patchGeneration, verificationPlans, verificationResults, reportRecord };
    } finally {
      // Dispose even when the reader's returned contract fails validation.
      if (snapshotOutput && typeof snapshotOutput === "object" && "id" in snapshotOutput && typeof snapshotOutput.id === "string") {
        await this.dependencies.snapshotReader.dispose?.(snapshotOutput.id);
      }
    }
  }

  private now(): string { return this.dependencies.clock?.() ?? new Date().toISOString(); }
  private append(manifest: IncidentManifest, id: string, content: JsonValue, type: string, locator: string): EvidenceItem {
    const timestamp = this.now();
    const item = withEvidenceHash({ schemaVersion: 1, kind: "EvidenceItem", id, incidentId: manifest.incidentId,
      correlationId: manifest.correlationId, createdAt: timestamp, capturedAt: timestamp, content,
      source: { type, locator }, redaction: { status: "not-required" }, provenance: { actor: "recovery-pipeline", tool: "pipeline-composition-v1" } });
    checked(validateEvidenceItem(item), manifest);
    return this.dependencies.evidenceStore.append(item);
  }
  private persist(value: VersionedContract & { readonly kind: string }, manifest: IncidentManifest): void {
    this.append(manifest, `artifact-${value.contentHash.slice(7)}`, value as unknown as JsonValue, "pipeline-artifact", `${value.kind}:${value.id}`);
  }
  private resolveEvidence(ids: readonly string[], manifest: Pick<IncidentManifest, "incidentId" | "correlationId">): EvidenceItem[] {
    return ids.map((id) => {
      const value = this.dependencies.evidenceStore.get(id);
      if (!value) throw new RecoveryPipelineError("UNRESOLVED_EVIDENCE", `Missing evidence: ${id}`);
      return checked(validateEvidenceItem(value), manifest);
    });
  }
  private evidence(manifest: IncidentManifest): readonly EvidenceItem[] {
    return this.dependencies.evidenceStore.list({ incidentId: manifest.incidentId, correlationId: manifest.correlationId }).map((item) => checked(validateEvidenceItem(item), manifest));
  }
  private matchesSignature(evidence: readonly EvidenceItem[], signature: string): boolean {
    return evidence.some((item) => {
      if (typeof item.content === "string") return item.content.includes(signature);
      if (!item.content || typeof item.content !== "object" || Array.isArray(item.content)) return false;
      const capture = item.content as Record<string, JsonValue>;
      if (capture.encoding !== "base64" || capture.textEncoding !== "utf8") return false;
      return [capture.stdout, capture.stderr].some((value) => typeof value === "string" && Buffer.from(value, "base64").toString("utf8").includes(signature));
    });
  }
  private assertRequest(request: RecoveryPipelineRequest): void {
    if (!request || !request.expectedBaselineFailure || !/^[A-Za-z0-9_-]{1,128}$/u.test(request.expectedBaselineFailure.code) || typeof request.expectedBaselineFailure.signature !== "string" || !request.expectedBaselineFailure.signature.trim() || request.expectedBaselineFailure.signature.length > 512) throw new RecoveryPipelineError("EXPECTED_BASELINE_SIGNATURE_REQUIRED");
    if (!request.modelPolicy || !safePaths(request.modelPolicy.targetPaths) || request.modelPolicy.targetPaths.length > 3 || !safePaths(request.modelPolicy.allowedPaths)) throw new RecoveryPipelineError("BOUNDED_MODEL_TARGETS_REQUIRED");
    if (!request.repositoryCapability || !safePaths(request.repositoryCapability.allowedPaths)) throw new RecoveryPipelineError("REPOSITORY_CAPABILITY_MISMATCH");
    if (!request.baselineCapability || !Array.isArray(request.baselineCapability.allowedCommands) || !request.baselineCapability.allowedCommands.length || request.baselineCapability.allowedCommands.some((command) => typeof command !== "string" || !command.trim())) throw new RecoveryPipelineError("EXECUTION_CAPABILITY_MISMATCH");
    if (request.verificationTimeoutMs !== undefined && (!Number.isSafeInteger(request.verificationTimeoutMs) || request.verificationTimeoutMs < 1 || request.verificationTimeoutMs > 1_800_000)) throw new RecoveryPipelineError("INVALID_VERIFICATION_TIMEOUT");
    if (request.evidence !== undefined && (!Array.isArray(request.evidence) || request.evidence.length > 128)) throw new RecoveryPipelineError("INVALID_EVIDENCE_INPUT");
    if (request.signal?.aborted) throw new RecoveryPipelineError("CANCELLED");
  }
  private validateCapabilities(request: RecoveryPipelineRequest, manifest: IncidentManifest): void {
    if (!request.repositoryCapability || !same(request.repositoryCapability.repositoryRevision, manifest.repositoryRevision) || !request.repositoryCapability.allowedPaths.length || request.repositoryCapability.allowedPaths.some((path) => !within(path, manifest.allowedPaths))) throw new RecoveryPipelineError("REPOSITORY_CAPABILITY_MISMATCH");
    if (!request.baselineCapability || request.baselineCapability.networkAccess !== (manifest.policy.networkAccess ?? "disabled") || !Number.isSafeInteger(request.baselineCapability.timeoutMs) || request.baselineCapability.timeoutMs < 1 || request.baselineCapability.timeoutMs > 1_800_000) throw new RecoveryPipelineError("EXECUTION_CAPABILITY_MISMATCH");
    for (const command of [manifest.reproductionCommand, ...manifest.testCommands]) {
      if (!request.baselineCapability.allowedCommands.includes(command.command) || !manifest.policy.allowedCommands?.includes(command.command)) throw new RecoveryPipelineError("COMMAND_NOT_AUTHORIZED");
    }
    if (!request.modelPolicy.allowedPaths.length || request.modelPolicy.allowedPaths.some((path) => !within(path, request.repositoryCapability.allowedPaths)) || request.modelPolicy.targetPaths.some((path) => !within(path, request.modelPolicy.allowedPaths))) throw new RecoveryPipelineError("PATCH_SCOPE_MISMATCH");
  }

  private readonly expectations = new Map<string, RecoveryPipelineRequest["expectedBaselineFailure"]>();
  /** Recheck worker evidence before the orchestrator can advance to patch application. */
  private checkedRunner(runner: VerificationRunner): VerificationRunner {
    const outcome = (value: unknown, plan: VerificationPlan): CommandOutcome => {
      const parsed = value as CommandOutcome;
      if (!parsed || !["succeeded", "failed", "timed-out", "cancelled", "blocked"].includes(parsed.status) || !(parsed.exitCode === null || Number.isSafeInteger(parsed.exitCode)) || !Array.isArray(parsed.evidenceIds) || !parsed.evidenceIds.length || parsed.evidenceIds.some((id) => typeof id !== "string")) throw new RecoveryPipelineError("INVALID_VERIFICATION_OUTPUT");
      if ((parsed.status === "succeeded" && parsed.exitCode !== 0) || (parsed.status === "failed" && (parsed.exitCode === 0 || parsed.exitCode === null))) throw new RecoveryPipelineError("INCONSISTENT_VERIFICATION_EXIT");
      this.resolveEvidence(parsed.evidenceIds, plan);
      return parsed;
    };
    return {
      createWorkspace: (request) => runner.createWorkspace(request),
      runBaseline: async (request) => {
        const parsed = outcome(await runner.runBaseline(request), request.plan);
        const expectation = this.expectations.get(request.plan.id);
        if (!expectation) throw new RecoveryPipelineError("MISSING_BASELINE_EXPECTATION");
        const reproduced = parsed.status === "failed" && parsed.exitCode !== null && parsed.exitCode !== 0 && this.matchesSignature(this.resolveEvidence(parsed.evidenceIds, request.plan), expectation.signature);
        return { ...parsed, reproduced, ...(reproduced ? { failureCode: expectation.code } : {}) };
      },
      applyPatch: async (request) => {
        const value = await runner.applyPatch(request) as { applied: boolean; receiptId: string; evidenceIds: string[] };
        if (!value || typeof value.applied !== "boolean" || typeof value.receiptId !== "string" || !value.receiptId || !Array.isArray(value.evidenceIds) || !value.evidenceIds.length) throw new RecoveryPipelineError("INVALID_PATCH_OUTPUT");
        this.resolveEvidence(value.evidenceIds, request.plan);
        return value;
      },
      runChecks: async (request) => {
        const value = await runner.runChecks(request) as { executions: unknown[] };
        if (!value || !Array.isArray(value.executions) || value.executions.length !== request.plan.verificationCommands.length) throw new RecoveryPipelineError("INVALID_CHECK_OUTPUT");
        return { executions: value.executions.map((execution) => outcome(execution, request.plan)) };
      },
      cleanup: (request) => runner.cleanup(request),
    };
  }
}

export function createRecoveryPipeline(dependencies: RecoveryPipelineDependencies): RecoveryPipeline {
  return new RecoveryPipeline(dependencies);
}
