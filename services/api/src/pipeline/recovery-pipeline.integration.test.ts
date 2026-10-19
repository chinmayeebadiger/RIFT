import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AuditEvent, CandidatePatch, CommandSpec, EvidenceItem, IncidentManifest, JsonValue, RepositorySnapshot } from "@rift/core";
import { validateCommandExecution, validateHypothesisSet, validateInvestigationResult, validateRecoveryReport, validateVerificationResult } from "@rift/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalEvidenceStore } from "../domain/evidence-store.js";
import { sha256, withEvidenceHash } from "../domain/hashing.js";
import { BoundedCommandExecutor, LocalProcessAdapter } from "../investigation/command-executor.js";
import { RepositorySnapshotReaderAdapter } from "../investigation/repository-snapshot.js";
import type { CandidatePatchModelInput, CandidatePatchProvider } from "../model-adapter/types.js";
import { InMemoryReportStore } from "../report/store.js";
import type { HumanApprovalRequest } from "../report/ports.js";
import type { CommandOutcome, VerificationRunner, VerificationWorkspace } from "../verification/ports.js";
import { RecoveryPipeline, type RecoveryPipelineDependencies, type RecoveryPipelineRequest } from "./index.js";

const execute = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const FIXTURE = join(ROOT, "tests/fixtures/integrated-recovery");
const REVISION = "89bea49f373a23bda2666808976e2e15d707b6e7";
const NOW = "2026-10-18T12:00:00.000Z";
const REGRESSION_NAMES = [
  "clamps decrements at one and removes an item when it reaches zero",
  "applies a valid coupon discount exactly once to the total",
  "rejects an expired coupon during checkout",
  "searches product names case-insensitively",
];
type RunnerRequest<K extends keyof VerificationRunner> = Parameters<VerificationRunner[K]>[0];

function hashed<T extends object>(value: T): T & { contentHash: string } {
  return { ...value, contentHash: sha256(value as unknown as JsonValue) };
}
async function fileHash(path: string): Promise<string> {
  return `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
}
function expectCanonical(value: { readonly contentHash: string }): void {
  const { contentHash, ...body } = value;
  expect(contentHash).toBe(sha256(body as JsonValue));
}

/** Test-only trusted fixture execution: actual processes, no claimed/faked success. */
async function runFixtureCommand(command: CommandSpec, workspace: string, signal?: AbortSignal): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const result = await execute(command.command, [...(command.args ?? [])], {
      cwd: resolve(workspace, command.workingDirectory ?? "."), signal, timeout: 20_000,
      maxBuffer: 1_048_576, env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
    // Infrastructure errors and killed processes must never masquerade as a red test suite.
    if (typeof failed.code !== "number" || failed.killed) throw error;
    return { exitCode: failed.code, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

/** Copies offline dependencies, never symlinks or bind-mounts the host installation. */
async function copyOfflineDependencies(workspace: string): Promise<void> {
  await execute("cp", ["-R", join(ROOT, "demo/node_modules"), join(workspace, "demo/node_modules")]);
  expect((await lstat(join(workspace, "demo/node_modules"))).isSymbolicLink()).toBe(false);
  expect((await lstat(join(workspace, "demo/node_modules/vitest/vitest.mjs"))).isFile()).toBe(true);
}

/**
 * Explicitly injected only below. This is not a production sandbox: it executes
 * reviewed fixture source on the test host, in independent temporary copies.
 */
class TrustedLocalFixtureRunner implements VerificationRunner {
  public readonly sourceCopies: string[] = [];
  public readonly commands: Array<{ phase: "baseline" | "patched"; exitCode: number; output: string }> = [];
  public patchApplications = 0;
  private readonly workspaces = new Map<string, string>();
  public constructor(private readonly store: LocalEvidenceStore, private readonly manifest: IncidentManifest, private readonly snapshotSource: () => string) {}

  public async createWorkspace(request: RunnerRequest<"createWorkspace">): Promise<VerificationWorkspace> {
    const directory = await mkdtemp(join(tmpdir(), "rift-integrated-fixture-"));
    this.sourceCopies.push(directory);
    const source = this.snapshotSource();
    await cp(source, directory, { recursive: true, filter: (path) => path !== join(source, "demo/node_modules") });
    await copyOfflineDependencies(directory);
    const workspace = { id: `fixture-${randomUUID()}`, phase: request.phase };
    this.workspaces.set(workspace.id, directory);
    return workspace;
  }
  public async runBaseline(request: RunnerRequest<"runBaseline">): Promise<CommandOutcome> {
    return this.runCommand(request.plan.baselineCommand, request.workspace, request.signal);
  }
  public async applyPatch(request: RunnerRequest<"applyPatch">) {
    this.patchApplications += 1;
    expect(request.applicationOrdinal).toBe(1);
    const directory = this.directory(request.workspace);
    const patchPath = join(directory, "candidate.diff");
    await writeFile(patchPath, request.patch.diff);
    const check = await execute("git", ["apply", "--check", patchPath], { cwd: directory, signal: request.signal });
    const apply = await execute("git", ["apply", patchPath], { cwd: directory, signal: request.signal });
    const evidence = this.append({ diff: request.patch.diff, patchHash: request.patch.contentHash, checkOutput: check.stdout + check.stderr, applyOutput: apply.stdout + apply.stderr }, "patch-application");
    return { applied: true, receiptId: evidence.id, evidenceIds: [evidence.id] };
  }
  public async runChecks(request: RunnerRequest<"runChecks">) {
    const executions: CommandOutcome[] = [];
    for (const command of request.plan.verificationCommands) executions.push(await this.runCommand(command, request.workspace, request.signal));
    return { executions };
  }
  public async cleanup(request: RunnerRequest<"cleanup">): Promise<void> {
    for (const workspace of request.workspaces) {
      await rm(this.directory(workspace), { recursive: true, force: true });
      this.workspaces.delete(workspace.id);
    }
  }
  private directory(workspace: VerificationWorkspace): string {
    const directory = this.workspaces.get(workspace.id);
    if (!directory) throw new Error("Unknown fixture workspace");
    return directory;
  }
  private append(content: JsonValue, type: string): EvidenceItem {
    return this.store.append(withEvidenceHash({ kind: "EvidenceItem", schemaVersion: 1, id: `fixture-evidence-${randomUUID()}`,
      incidentId: this.manifest.incidentId, correlationId: this.manifest.correlationId, createdAt: NOW, capturedAt: NOW,
      content, source: { type, locator: `fixture:${type}` }, redaction: { status: "not-required" }, provenance: { actor: "trusted-local-fixture-runner", tool: "actual-process-execution" },
    }));
  }
  private async runCommand(command: CommandSpec, workspace: VerificationWorkspace, signal: AbortSignal): Promise<CommandOutcome> {
    const result = await runFixtureCommand(command, this.directory(workspace), signal);
    const output = `${result.stdout}${result.stderr}`;
    this.commands.push({ phase: workspace.phase, exitCode: result.exitCode, output });
    const stdout = this.append(result.stdout, "command-stdout");
    const stderr = this.append(result.stderr, "command-stderr");
    return { status: result.exitCode === 0 ? "succeeded" : "failed", exitCode: result.exitCode, evidenceIds: [stdout.id, stderr.id], reproduced: result.exitCode !== 0 && output.includes("4 failed"), ...(result.exitCode ? { failureCode: "RIFT_SHOP_REGRESSION_FAILURE" } : {}) };
  }
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function harness(label: string) {
  const directory = await mkdtemp(join(tmpdir(), "rift-pipeline-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalEvidenceStore(join(directory, "evidence.jsonl"));
  const reports = new InMemoryReportStore();
  const manifest: IncidentManifest = hashed({
    kind: "IncidentManifest", schemaVersion: 1, id: `manifest-${label}`, incidentId: `RIFT-${label}`, correlationId: `run-${label}`,
    createdAt: NOW, repositoryRevision: { repository: "rift", revision: REVISION }, allowedPaths: ["demo"],
    logSources: [{ id: "observations", type: "application-log", locator: "tests/fixtures/integrated-recovery/observations.log" }],
    reproductionCommand: { command: "node", args: ["node_modules/vitest/vitest.mjs", "run", "src/domain/shop.regression.test.ts", "--maxWorkers", "1", "--minWorkers", "1", "--reporter=verbose"], workingDirectory: "demo" },
    // shop.test.ts deliberately asserts the seeded defects; it is not a post-repair check.
    testCommands: [],
    timeWindow: { start: "2026-10-18T11:55:00.000Z", end: NOW }, policy: { networkAccess: "disabled", allowedCommands: ["node"], maxEvidenceBytes: 1_048_576, redactSecrets: true },
  } satisfies Omit<IncidentManifest, "contentHash">);
  const observations = withEvidenceHash({ kind: "EvidenceItem", schemaVersion: 1, id: `observations-${label}`, incidentId: manifest.incidentId,
    correlationId: manifest.correlationId, createdAt: NOW, capturedAt: NOW, content: await readFile(join(FIXTURE, "observations.log"), "utf8"),
    source: { type: "application-log", locator: manifest.logSources[0].locator }, redaction: { status: "not-required" }, provenance: { actor: "synthetic-fixture-author", tool: "fixture-import" },
  });
  const reader = new RepositorySnapshotReaderAdapter({ repositoryRoot: ROOT, snapshotRoot: directory, clock: () => NOW });
  cleanup.push(() => reader.dispose());
  let snapshotSource: string | undefined;
  const snapshotReader = {
    async read(request: Parameters<typeof reader.read>[0]) {
      const snapshot = await reader.read(request) as RepositorySnapshot;
      snapshotSource = reader.getSnapshotWorkspace(snapshot.id)!;
      await copyOfflineDependencies(snapshotSource);
      return snapshot;
    },
    dispose: (id: string) => reader.dispose(id),
  };
  const executor = new BoundedCommandExecutor({ snapshotProvider: reader, processAdapter: LocalProcessAdapter(), clock: () => NOW });
  const runner = new TrustedLocalFixtureRunner(store, manifest, () => {
    if (!snapshotSource) throw new Error("No fixture snapshot");
    return snapshotSource;
  });
  cleanup.push(async () => { for (const copy of runner.sourceCopies) await rm(copy, { recursive: true, force: true }); });
  const diff = await readFile(join(FIXTURE, "all-four-fixes.diff"), "utf8");
  const provider: CandidatePatchProvider = {
    name: "synthetic-all-four-fixes",
    generate: vi.fn(async (serialized: string) => {
      // Proposal is possible only after actual red output has entered append-only storage.
      expect(store.list({ sourceType: "command-stdout" }).some((item) => typeof item.content === "string" && item.content.includes("4 failed"))).toBe(true);
      const input = JSON.parse(serialized) as CandidatePatchModelInput;
      return JSON.stringify(hashed({ kind: "CandidatePatch", schemaVersion: 1, id: `candidate-${label}`, incidentId: input.incidentId,
        correlationId: input.correlationId, createdAt: input.createdAt, sourceHypothesisId: input.hypothesisId, baseRevision: input.repositoryRevision,
        diff, touchedPaths: ["demo/src/domain/shop.ts"], rationale: "Restore cart quantity, discount, coupon expiry and case-insensitive search invariants.",
        expectedInvariant: "Zero-quantity items are removed; discounts apply once; expired coupons are rejected; product search ignores letter case.", generatedBy: { actor: "fake-model", model: "synthetic-fixture" },
      } satisfies Omit<CandidatePatch, "contentHash">));
    }),
  };
  const audit: AuditEvent[] = [];
  const dependencies: RecoveryPipelineDependencies = { evidenceStore: store, reportStore: reports, snapshotReader, baselineExecutor: executor,
    patchProvider: provider, verificationRunner: runner, verificationAudit: { append: (event) => { audit.push(event); } }, clock: () => NOW };
  const request: RecoveryPipelineRequest = {
    manifest, repositoryCapability: { repositoryRevision: manifest.repositoryRevision, allowedPaths: manifest.allowedPaths },
    baselineCapability: { allowedCommands: ["node"], networkAccess: "disabled", timeoutMs: 20_000 },
    expectedBaselineFailure: { code: "RIFT_SHOP_REGRESSION_FAILURE", signature: "4 failed" },
    modelPolicy: { authorized: true, actor: "fake-model", allowedPaths: ["demo/src/domain/shop.ts"], targetPaths: ["demo/src/domain/shop.ts"] },
    evidence: [observations], verificationTimeoutMs: 20_000,
  };
  return { dependencies, request, store, reports, runner, provider, executor, reader, audit, directory };
}

describe("integrated evidence-backed recovery composition", () => {
  it("keeps the synthetic unified diff applicable to the real pinned demo source", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rift-fixture-diff-check-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const reader = new RepositorySnapshotReaderAdapter({ repositoryRoot: ROOT, snapshotRoot: directory });
    cleanup.push(() => reader.dispose());
    const repositoryRevision = { repository: "rift", revision: REVISION };
    const snapshot = await reader.read({ incidentId: "RIFT-diff-check", correlationId: "run-diff-check", repositoryRevision,
      capability: { repositoryRevision, allowedPaths: ["demo/src/domain/shop.ts"] } }) as RepositorySnapshot;
    await execute("git", ["apply", "--check", join(FIXTURE, "all-four-fixes.diff")], { cwd: reader.getSnapshotWorkspace(snapshot.id) });
  }, 60_000);

  it("executes all four real regressions red, applies the fixture diff in another source copy, and persists green evidence pending human approval", async () => {
    const sourcePath = join(ROOT, "demo/src/domain/shop.ts");
    const testsPath = join(ROOT, "demo/src/domain/shop.regression.test.ts");
    const untouched = [await fileHash(sourcePath), await fileHash(testsPath)];
    const h = await harness("integrated");
    const result = await new RecoveryPipeline(h.dependencies).run(h.request);
    expect(result.reproduced).toBe(true);
    expect(result.baseline.exitCode).toBe(1);
    expect(validateCommandExecution(result.baseline).ok).toBe(true);
    expect(validateHypothesisSet(result.hypothesisSet).ok).toBe(true);
    expect(result.hypothesisSet.hypotheses.length).toBeGreaterThanOrEqual(4);
    expect(validateInvestigationResult(result.investigation).ok).toBe(true);
    expect(result.patchGeneration.ranking?.entries[0].rank).toBe(1);
    expect(result.patchGeneration.candidatePatches[0].diff).toBe(await readFile(join(FIXTURE, "all-four-fixes.diff"), "utf8"));
    expect(h.provider.generate).toHaveBeenCalledTimes(1);
    expect(h.runner.patchApplications).toBe(1);
    expect(h.runner.sourceCopies).toHaveLength(2);
    expect(new Set(h.runner.sourceCopies).size).toBe(2);
    const baseline = h.runner.commands.find((command) => command.phase === "baseline")!;
    const patched = h.runner.commands.find((command) => command.phase === "patched")!;
    expect(baseline.exitCode).toBe(1);
    expect(baseline.output).toMatch(/4 failed/u);
    expect(patched.exitCode).toBe(0);
    expect(patched.output).toMatch(/4 passed/u);
    for (const name of REGRESSION_NAMES) { expect(baseline.output).toContain(name); expect(patched.output).toContain(name); }
    expect(h.runner.commands).toHaveLength(2); // isolated baseline and patched regressions
    expect(result.verificationResults).toHaveLength(1);
    expect(result.verificationResults[0]).toMatchObject({ classification: "verified", baselineExitCode: 1, patchedExitCode: 0 });
    expect(validateVerificationResult(result.verificationResults[0]).ok).toBe(true);
    expect(validateRecoveryReport(result.reportRecord.report).ok).toBe(true);
    expect(result.reportRecord.report.status).toBe("verified");
    expect(result.reportRecord.approval.status).toBe("pending");
    expect(h.reports.get(result.reportRecord.report.id)).toEqual(result.reportRecord);
    for (const artifact of [result.manifest, result.snapshot, result.baseline, result.normalization, result.timeline, result.hypothesisSet,
      ...result.hypothesisSet.hypotheses, result.investigation, result.patchGeneration, ...result.patchGeneration.candidatePatches,
      ...result.verificationPlans, ...result.verificationResults, result.reportRecord.report]) expectCanonical(artifact);
    const citations = [...result.timeline.events.flatMap((event) => event.citations), ...result.investigation.hypothesisEvidence.flatMap((entry) => entry.citations), ...result.reportRecord.report.evidenceCitations];
    for (const citation of citations) expect(h.store.get(citation.evidenceId)?.contentHash).toBe(citation.evidenceHash);
    for (const id of [...result.baseline.evidenceIds, ...result.investigation.evidenceIds, ...result.verificationResults.flatMap((verification) => verification.evidenceIds), ...result.reportRecord.report.evidenceIds]) expect(h.store.get(id)).toBeDefined();
    const savedEvidence = h.store.list();
    for (const evidence of savedEvidence) { expectCanonical(evidence); expect(evidence.incidentId).toBe(result.manifest.incidentId); expect(evidence.correlationId).toBe(result.manifest.correlationId); }
    expect(new LocalEvidenceStore(join(h.directory, "evidence.jsonl")).list()).toEqual(savedEvidence);
    expect(() => h.store.append({ ...savedEvidence[0], content: "attempted replacement" })).toThrow();
    expect(h.store.list()).toEqual(savedEvidence);
    expect(h.audit.some((event) => event.action === "verification.patch" || event.stage === "patch")).toBe(true);
    const modelApproval = { actorKind: "model", actorId: "fixture-model", decision: "approved" } as unknown as HumanApprovalRequest;
    expect(() => h.reports.recordApproval(result.reportRecord.report.id, modelApproval, NOW)).toThrow("Only a human actor");
    expect(h.reports.get(result.reportRecord.report.id)?.approval.status).toBe("pending");
    // A separate store demonstrates human intent recording without changing the pending run.
    const humanIntentStore = new InMemoryReportStore([result.reportRecord]);
    expect(humanIntentStore.recordApproval(result.reportRecord.report.id, { actorKind: "human", actorId: "reviewer", decision: "approved", note: "Review intent only; no deployment capability." }, NOW).approval.status).toBe("approved");
    expect(h.reports.get(result.reportRecord.report.id)?.approval.status).toBe("pending");
    expect([await fileHash(sourcePath), await fileHash(testsPath)]).toEqual(untouched);
    for (const directory of h.runner.sourceCopies) await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(h.reader.getSnapshotWorkspace(result.snapshot.id)).toBeUndefined();
  }, 60_000);

  it("skips the model, patch and isolated verification when the actual baseline is green", async () => {
    const h = await harness("nonreproduced");
    const manifest = h.request.manifest as IncidentManifest;
    const reproductionCommand = { ...manifest.reproductionCommand, args: ["node_modules/vitest/vitest.mjs", "run", "src/domain/shop.test.ts", "--maxWorkers", "1", "--minWorkers", "1"] };
    const result = await new RecoveryPipeline(h.dependencies).run({ ...h.request, manifest: { ...manifest, reproductionCommand } });
    expect(result.baseline.exitCode).toBe(0);
    expect(result.reproduced).toBe(false);
    expect(h.provider.generate).not.toHaveBeenCalled();
    expect(h.runner.sourceCopies).toEqual([]);
    expect(h.runner.patchApplications).toBe(0);
    expect(result.patchGeneration.candidatePatches).toEqual([]);
    expect(result.verificationResults).toEqual([]);
    expect(result.reportRecord.report.status).toBe("not-reproduced");
    expect(result.reportRecord.approval.status).toBe("pending");
  }, 60_000);

  it("requires the expected signature even when the real baseline exits nonzero", async () => {
    const h = await harness("signature-mismatch");
    const result = await new RecoveryPipeline(h.dependencies).run({ ...h.request, expectedBaselineFailure: { code: "OTHER_FAILURE", signature: "expected-signature-not-emitted-by-this-fixture" } });
    expect(result.baseline.exitCode).toBe(1);
    expect(result.reproduced).toBe(false);
    expect(h.provider.generate).not.toHaveBeenCalled();
    expect(h.runner.sourceCopies).toEqual([]);
    expect(result.reportRecord.report.status).toBe("not-reproduced");
  }, 60_000);

  it("rejects a worker's noncanonical snapshot before baseline or model execution", async () => {
    const h = await harness("invalid-worker");
    const executeBaseline = vi.spyOn(h.executor, "execute");
    const snapshotReader = { ...h.dependencies.snapshotReader, read: async (request: Parameters<RepositorySnapshotReaderAdapter["read"]>[0]) => {
      const snapshot = await h.dependencies.snapshotReader.read(request) as RepositorySnapshot;
      return { ...snapshot, contentHash: `sha256:${"0".repeat(64)}` };
    } };
    await expect(new RecoveryPipeline({ ...h.dependencies, snapshotReader }).run({ ...h.request, evidence: [] })).rejects.toMatchObject({ code: "CONTENT_HASH_MISMATCH" });
    expect(executeBaseline).not.toHaveBeenCalled();
    expect(h.provider.generate).not.toHaveBeenCalled();
    expect(h.reports.list()).toEqual([]);
  }, 60_000);
});
