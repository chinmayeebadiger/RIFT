import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CandidatePatch, CommandSpec, IncidentManifest, JsonValue, VerificationPlan } from "@rift/core";
import { validateEvidenceItem } from "@rift/core";
import { InMemoryEvidenceStore, LocalEvidenceStore } from "../domain/evidence-store.js";
import { computeEvidenceHash, sha256 } from "../domain/hashing.js";
import type { ProcessResult, ProcessRunner, ProcessRunOptions } from "./docker-runner.js";
import { BoundedVerificationConcurrency, VerificationOrchestrator, verificationIdempotencyKey } from "./orchestrator.js";
import type { VerificationWorkspace } from "./ports.js";
import { BoundedStagedProcessRunner, StagedDockerVerificationRunner, type StagedDockerRunnerOptions } from "./staged-docker-runner.js";

const REVISION = { repository: "rift-demo", revision: "a".repeat(40) };
const IMAGE = `rift-runner@sha256:${"b".repeat(64)}`;
const TIME = "2026-10-18T10:00:00.000Z";
const COMMAND: CommandSpec = { command: "npm", args: ["test", "--", "--run", "src/checkout.test.ts"], workingDirectory: "demo" };
const SIGNATURE = "discount applied twice: expected 900, received 810";
const success = (stdout = ""): ProcessResult => ({ exitCode: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) });
const failure = (stdout = SIGNATURE): ProcessResult => ({ ...success(stdout), exitCode: 1 });
function captureText(content: JsonValue, stream = "stdout"): string {
  const record = content as Record<string, JsonValue>;
  return record.encoding === "base64" ? Buffer.from(record[stream] as string, "base64").toString("utf8") : "";
}

function fixtures() {
  const common = { schemaVersion: 1 as const, incidentId: "RIFT-042", correlationId: "correlation-1", createdAt: TIME, contentHash: `sha256:${"c".repeat(64)}` };
  const manifest: IncidentManifest = { ...common, kind: "IncidentManifest", id: "manifest-1", repositoryRevision: REVISION, allowedPaths: ["demo"],
    logSources: [{ id: "fixture-log", type: "fixture", locator: "fixture/checkout.log" }], reproductionCommand: COMMAND, testCommands: [COMMAND], timeWindow: { start: TIME, end: TIME },
    policy: { networkAccess: "disabled", allowedCommands: ["npm"], maxEvidenceBytes: 8192 } };
  const plan: VerificationPlan = { ...common, kind: "VerificationPlan", id: "plan-1", candidatePatchId: "patch-1", baseRevision: REVISION,
    baselineCommand: COMMAND, verificationCommands: [COMMAND], timeoutMs: 1000, networkAccess: "disabled" };
  const patch: CandidatePatch = { ...common, kind: "CandidatePatch", id: "patch-1", sourceHypothesisId: "hypothesis-1", baseRevision: REVISION,
    diff: "diff --git a/demo/src/checkout.ts b/demo/src/checkout.ts\n--- a/demo/src/checkout.ts\n+++ b/demo/src/checkout.ts\n@@ -1 +1 @@\n-old\n+new\n",
    touchedPaths: ["demo/src/checkout.ts"], rationale: "Apply the discount once.", expectedInvariant: "Discount is applied exactly once.", generatedBy: { actor: "human" } };
  return { manifest, plan, patch, correlationId: common.correlationId };
}

interface Call { command: string; args: readonly string[]; options: ProcessRunOptions }
class FakeProcessRunner implements ProcessRunner {
  public readonly calls: Call[] = [];
  public baseline = failure();
  public check = success("patched checks passed\n");
  public tree = `100644 blob ${"d".repeat(40)}\tdemo/src/checkout.ts\0`;
  public hook?: (call: Call) => ProcessResult | Promise<ProcessResult> | undefined;
  public async run(command: string, args: readonly string[], options: ProcessRunOptions = {}): Promise<ProcessResult> {
    const call = { command, args: [...args], options };
    this.calls.push(call);
    const result = this.hook?.(call);
    if (result !== undefined) return result;
    if (command === "git") {
      if (args.includes("rev-parse")) return success(`${REVISION.revision}\n`);
      if (args.includes("ls-tree")) return success(this.tree);
      if (args.includes("archive")) return success("synthetic pinned archive");
      throw new Error("unexpected host operation");
    }
    if (args[0] === "create") return success("synthetic-container-id\n");
    if (args[0] === "exec" && args.includes("npm")) return args.some((arg) => arg.endsWith("-baseline")) ? this.baseline : this.check;
    return success();
  }
}

interface SetupFixture {
  process: FakeProcessRunner;
  store: InMemoryEvidenceStore;
  input: ReturnType<typeof fixtures>;
  runner: StagedDockerVerificationRunner;
  signal: AbortSignal;
  context: { runId: string; correlationId: string; manifest: IncidentManifest; plan: VerificationPlan; signal: AbortSignal };
}
const owned: SetupFixture[] = [];
function setup(overrides: Partial<StagedDockerRunnerOptions> = {}): SetupFixture {
  const process = new FakeProcessRunner();
  const store = new InMemoryEvidenceStore();
  const input = fixtures();
  const runner = new StagedDockerVerificationRunner({ repositoryPath: "/fixture/read-only-repository", repository: REVISION.repository,
    image: IMAGE, evidenceStore: store, expectedBaselineFailure: { code: "DOUBLE_DISCOUNT", signature: SIGNATURE },
    docker: process, host: process, cleanupTimeoutMs: 100, ...overrides });
  const signal = new AbortController().signal;
  const context = { runId: "verification-1", correlationId: input.correlationId, manifest: input.manifest, plan: input.plan, signal };
  const allocation = { process, store, input, runner, signal, context };
  owned.push(allocation);
  return allocation;
}
async function reproduced(fixture: ReturnType<typeof setup>) {
  const baseline = await fixture.runner.createWorkspace({ ...fixture.context, phase: "baseline" });
  await fixture.runner.runBaseline({ ...fixture.context, workspace: baseline });
  return fixture.runner.createWorkspace({ ...fixture.context, phase: "patched" });
}
function patchRequest(fixture: ReturnType<typeof setup>, workspace: VerificationWorkspace) {
  return { ...fixture.context, workspace, patch: fixture.input.patch, applicationOrdinal: 1 as const, idempotencyKey: sha256("apply-once") };
}
afterEach(async () => {
  for (const fixture of owned.splice(0)) {
    fixture.process.hook = undefined;
    await fixture.runner.cleanup({ ...fixture.context, workspaces: [] }).catch(() => undefined);
  }
});

describe("StagedDockerVerificationRunner", () => {
  it("composes with the real staged orchestrator and returns persisted raw evidence from isolated phases", async () => {
    const f = setup({ offlineDependencies: [{ imagePath: "/app/demo/node_modules", workspacePath: "demo/node_modules" }] });
    const orchestrator = new VerificationOrchestrator(f.runner, { append: () => undefined }, new BoundedVerificationConcurrency(1));
    const request = { ...f.input, idempotencyKey: verificationIdempotencyKey(f.input), baselineExpectation: { expectedFailureCode: "DOUBLE_DISCOUNT" } };
    const result = await orchestrator.start(request).result;
    expect(result.classification).toBe("verified");
    expect(result.evidenceIds.length).toBeGreaterThanOrEqual(5);
    for (const id of result.evidenceIds) {
      const item = f.store.get(id)!;
      expect(item).toBeDefined();
      expect(validateEvidenceItem(item).ok).toBe(true);
      const { contentHash, ...withoutHash } = item;
      expect(contentHash).toBe(computeEvidenceHash(withoutHash));
      expect(item.correlationId).toBe(f.input.correlationId);
    }
    const captures = result.evidenceIds.map((id) => f.store.get(id)!.content as Record<string, JsonValue>);
    expect(captures.some((capture) => captureText(capture) === SIGNATURE)).toBe(true);
    expect(captures.some((capture) => captureText(capture) === "patched checks passed\n")).toBe(true);
    const creates = f.process.calls.filter((call) => call.args[0] === "create");
    expect(creates).toHaveLength(2);
    const names = creates.map((call) => call.args[call.args.indexOf("--name") + 1]);
    expect(new Set(names).size).toBe(2);
    for (const create of creates) {
      expect(create.args).toContain("--read-only");
      expect(create.args).toContain("65532:65532");
      expect(create.args[create.args.indexOf("--network") + 1]).toBe("none");
      expect(create.args[create.args.indexOf("--pull") + 1]).toBe("never");
      expect(create.args).toContain(IMAGE);
    }
    expect(f.process.calls.some((call) => call.args.some((arg) => ["--mount", "-v", "--volume", "--privileged"].includes(arg)))).toBe(false);
    const archives = f.process.calls.filter((call) => call.args.includes("archive"));
    expect(archives).toHaveLength(2);
    expect(archives[0].args).toContain("--literal-pathspecs");
    expect(archives[0].args.slice(-2)).toEqual(["--", "demo"]);
    expect(f.process.calls.filter((call) => call.args.includes("/app/demo/node_modules"))).toHaveLength(2);
    expect(f.process.calls.some((call) => call.args.includes("install") || call.args.includes("ci"))).toBe(false);
    expect(f.process.calls.filter((call) => call.args[0] === "rm")).toHaveLength(2);
  });

  it.each(["regressed", "not-reproduced", "inconclusive"])("preserves the orchestrator's %s fail-closed classification", async (classification) => {
    const f = setup();
    if (classification === "regressed") f.process.check = failure("patched regression");
    if (classification === "not-reproduced") f.process.baseline = failure("unrelated failure");
    if (classification === "inconclusive") f.process.hook = (call) => call.args[0] === "rm" ? { ...success(), timedOut: true } : undefined;
    const orchestrator = new VerificationOrchestrator(f.runner, { append: () => undefined }, new BoundedVerificationConcurrency(1));
    const run = orchestrator.start({ ...f.input, idempotencyKey: verificationIdempotencyKey(f.input) });
    f.context.runId = run.runId;
    const result = await run.result;
    expect(result.classification).toBe(classification);
    if (classification === "not-reproduced") expect(f.process.calls.some((call) => call.args.includes("apply"))).toBe(false);
    if (classification === "inconclusive") expect(result.failure?.code).toBe("CLEANUP_FAILED");
    expect(result.evidenceIds.length).toBeGreaterThan(0);
  });

  it.each([
    [failure("unrelated assertion failure"), false, "failed"],
    [success(SIGNATURE), false, "succeeded"],
    [{ ...failure(), timedOut: true }, false, "timed-out"],
    [{ ...failure(), cancelled: true }, false, "cancelled"],
    [{ ...failure(), exitCode: null }, false, "blocked"],
    [failure(), true, "failed"],
  ] as const)("requires a completed nonzero exit AND the configured retained signature (%j)", async (output, expected, status) => {
    const f = setup();
    f.process.baseline = output;
    const workspace = await f.runner.createWorkspace({ ...f.context, phase: "baseline" });
    const result = await f.runner.runBaseline({ ...f.context, workspace });
    expect(result.reproduced).toBe(expected);
    expect(result.status).toBe(status);
    expect(result.failureCode === "DOUBLE_DISCOUNT").toBe(expected);
    if (!expected) await expect(f.runner.createWorkspace({ ...f.context, phase: "patched" })).rejects.toThrow("BASELINE_NOT_REPRODUCED");
  });

  it("matches only the explicitly configured output stream", async () => {
    const f = setup({ expectedBaselineFailure: { code: "DOUBLE_DISCOUNT", signature: SIGNATURE, stream: "stderr" } });
    const workspace = await f.runner.createWorkspace({ ...f.context, phase: "baseline" });
    expect((await f.runner.runBaseline({ ...f.context, workspace })).reproduced).toBe(false);
  });

  it.each(["args", "directory", "environment", "checks", "policy", "network", "manifest-network", "incident", "correlation", "revision", "repository", "short-revision"])("rejects %s authorization mismatch before any process runs", async (change) => {
    const f = setup();
    const { manifest, plan } = f.input;
    let m = manifest, p = plan;
    if (change === "args") p = { ...p, baselineCommand: { ...COMMAND, args: ["run", "deploy"] } };
    if (change === "directory") p = { ...p, baselineCommand: { ...COMMAND, workingDirectory: "other" } };
    if (change === "environment") p = { ...p, baselineCommand: { ...COMMAND, environment: { NODE_OPTIONS: "--require=evil" } } };
    if (change === "checks") p = { ...p, verificationCommands: [{ command: "npm", args: ["publish"] }] };
    if (change === "policy") m = { ...m, policy: { ...m.policy, allowedCommands: [] } };
    if (change === "network") p = { ...p, networkAccess: "allowlisted" };
    if (change === "manifest-network") m = { ...m, policy: { ...m.policy, networkAccess: undefined } };
    if (change === "incident") p = { ...p, incidentId: "RIFT-999" };
    if (change === "correlation") p = { ...p, correlationId: "other-correlation" };
    if (change === "revision") p = { ...p, baseRevision: { ...REVISION, revision: "f".repeat(40) } };
    if (change === "repository") { m = { ...m, repositoryRevision: { ...REVISION, repository: "other" } }; p = { ...p, baseRevision: m.repositoryRevision }; }
    if (change === "short-revision") { m = { ...m, repositoryRevision: { ...REVISION, revision: "abcdef1" } }; p = { ...p, baseRevision: m.repositoryRevision }; }
    await expect(f.runner.createWorkspace({ ...f.context, manifest: m, plan: p, phase: "baseline" })).rejects.toThrow();
    expect(f.process.calls).toHaveLength(0);
  });

  it.each(["120000 blob", "160000 commit", "100644 blob"])("rejects symlinks, submodules and out-of-scope source entries (%s)", async (prefix) => {
    const f = setup();
    f.process.tree = `${prefix} ${"d".repeat(40)}\t${prefix === "100644 blob" ? "private/credentials.txt" : "demo/link"}\0`;
    await expect(f.runner.createWorkspace({ ...f.context, phase: "baseline" })).rejects.toThrow("UNSAFE_SOURCE_TREE");
    expect(f.process.calls.some((call) => call.args[0] === "create")).toBe(false);
  });

  it("rejects a truncated archive before creating Docker resources", async () => {
    const f = setup();
    f.process.hook = (call) => call.args.includes("archive") ? { ...success("archive"), stdoutTruncated: true } as ProcessResult : undefined;
    await expect(f.runner.createWorkspace({ ...f.context, phase: "baseline" })).rejects.toThrow("ARCHIVE_FAILED_OR_TOO_LARGE");
    expect(f.process.calls.some((call) => call.args[0] === "create")).toBe(false);
  });

  it("checks the shared diff validator, touched paths, scope, revisions and correlation before applying", async () => {
    const f = setup();
    const workspace = await reproduced(f);
    const request = patchRequest(f, workspace);
    const patches: CandidatePatch[] = [
      { ...request.patch, touchedPaths: ["demo/src/other.ts"] },
      { ...request.patch, diff: request.patch.diff.replaceAll("demo/src/checkout.ts", "private/checkout.ts"), touchedPaths: ["private/checkout.ts"] },
      { ...request.patch, diff: request.patch.diff.replaceAll("demo/src/checkout.ts", "demo/.env"), touchedPaths: ["demo/.env"] },
      { ...request.patch, baseRevision: { ...REVISION, revision: "e".repeat(40) } },
      { ...request.patch, incidentId: "RIFT-999" },
      { ...request.patch, correlationId: "other-correlation" },
      { ...request.patch, id: "unselected-patch" },
    ];
    for (const patch of patches) await expect(f.runner.applyPatch({ ...request, patch })).rejects.toThrow();
    expect(f.process.calls.some((call) => call.args.includes("apply"))).toBe(false);
    await expect(f.runner.applyPatch({ ...request, applicationOrdinal: 2 as 1 })).rejects.toThrow("INVALID_PATCH_APPLICATION");
    await expect(f.runner.runChecks({ ...f.context, workspace })).rejects.toThrow("PATCH_NOT_APPLIED");
  });

  it("applies once under simultaneous retries and reuses only an identical completed receipt", async () => {
    const f = setup();
    const workspace = await reproduced(f);
    const request = patchRequest(f, workspace);
    const first = f.runner.applyPatch(request);
    await expect(f.runner.applyPatch(request)).rejects.toThrow("PATCH_ALREADY_ATTEMPTED");
    const outcome = await first;
    expect(outcome.applied).toBe(true);
    expect(await f.runner.applyPatch(request)).toEqual(outcome);
    await expect(f.runner.applyPatch({ ...request, idempotencyKey: sha256("different-key") })).rejects.toThrow("PATCH_ALREADY_ATTEMPTED");
    const applications = f.process.calls.filter((call) => call.args.includes("apply"));
    expect(applications.filter((call) => call.args.includes("--check"))).toHaveLength(1);
    expect(applications.filter((call) => !call.args.includes("--check"))).toHaveLength(1);
    expect(f.store.get(outcome.receiptId)).toBeDefined();
  });

  it("never reapplies after uncertain apply, even if the transport claims exit zero", async () => {
    const f = setup();
    const workspace = await reproduced(f);
    f.process.hook = (call) => call.args.includes("apply") && !call.args.includes("--check") ? { ...success("partial apply output"), timedOut: true } : undefined;
    const request = patchRequest(f, workspace);
    const result = await f.runner.applyPatch(request);
    expect(result.applied).toBe(false);
    expect(result.failureCode).toBe("PATCH_EXECUTION_UNCERTAIN");
    expect(await f.runner.applyPatch(request)).toEqual(result);
    expect(f.process.calls.filter((call) => call.args.includes("apply") && !call.args.includes("--check"))).toHaveLength(1);
    await expect(f.runner.runChecks({ ...f.context, workspace })).rejects.toThrow("PATCH_NOT_APPLIED");
  });

  it("uses the durable patch intent to prevent replay by a new adapter instance", async () => {
    const first = setup();
    const workspace = await reproduced(first);
    expect((await first.runner.applyPatch(patchRequest(first, workspace))).applied).toBe(true);
    await first.runner.cleanup({ ...first.context, workspaces: [] });
    const restarted = setup({ evidenceStore: first.store });
    const fresh = await reproduced(restarted);
    await expect(restarted.runner.applyPatch(patchRequest(restarted, fresh))).rejects.toThrow("PATCH_ALREADY_ATTEMPTED");
    expect(restarted.process.calls.some((call) => call.args.includes("apply"))).toBe(false);
  });

  it("rejects workspace handle substitution and mutated context", async () => {
    const f = setup();
    const workspace = await f.runner.createWorkspace({ ...f.context, phase: "baseline" });
    await expect(f.runner.runBaseline({ ...f.context, runId: "other-run", workspace })).rejects.toThrow("WORKSPACE_CONTEXT_MISMATCH");
    await expect(f.runner.runBaseline({ ...f.context, plan: { ...f.input.plan, baselineCommand: { command: "npm", args: ["publish"] } }, workspace })).rejects.toThrow("WORKSPACE_CONTEXT_MISMATCH");
    await expect(f.runner.runBaseline({ ...f.context, workspace: { ...workspace, phase: "patched" } })).rejects.toThrow("WORKSPACE_CONTEXT_MISMATCH");
  });

  it("persists bounded, redacted raw stdout/stderr rather than only hashes", async () => {
    const f = setup({ redactValues: ["literal-sensitive-value"] });
    f.process.baseline = { ...failure(`${SIGNATURE}\npassword=hunter2\nliteral-sensitive-value\n${"x".repeat(100_000)}`), stderr: Buffer.from("Authorization: Bearer abcdef123456\n") };
    const workspace = await f.runner.createWorkspace({ ...f.context, phase: "baseline" });
    const outcome = await f.runner.runBaseline({ ...f.context, workspace });
    expect(outcome.reproduced).toBe(true);
    const evidence = f.store.get(outcome.evidenceIds[0])!;
    const content = evidence.content as Record<string, JsonValue>;
    expect(content.stdoutTruncated).toBe(true);
    expect(captureText(content)).toContain(SIGNATURE);
    expect(captureText(content)).toContain("[REDACTED]");
    expect(captureText(content) + captureText(content, "stderr")).not.toMatch(/hunter2|literal-sensitive-value|abcdef123456/u);
    expect(Buffer.byteLength(JSON.stringify(content))).toBeLessThanOrEqual(f.input.manifest.policy.maxEvidenceBytes!);
    expect(evidence.redaction.status).toBe("redacted");
    const before = f.store.list();
    expect(await f.runner.runBaseline({ ...f.context, workspace })).toEqual(outcome);
    expect(f.store.list()).toEqual(before);
  });

  it("does not match signatures outside retained output or signatures removed by redaction", async () => {
    for (const output of [`${"x".repeat(100_000)}${SIGNATURE}`, `password=${SIGNATURE}`]) {
      const f = setup();
      f.process.baseline = failure(output);
      const workspace = await f.runner.createWorkspace({ ...f.context, phase: "baseline" });
      expect((await f.runner.runBaseline({ ...f.context, workspace })).reproduced).toBe(false);
    }
  });

  it("retains partial captures from a cooperative transport on deadline", async () => {
    const f = setup();
    f.input.plan = { ...f.input.plan, timeoutMs: 10 };
    f.context.plan = f.input.plan;
    f.process.hook = (call) => call.args.includes("npm") ? new Promise((resolve) => call.options.signal!.addEventListener("abort", () => resolve({ ...failure("partial output before deadline"), cancelled: true }), { once: true })) : undefined;
    const workspace = await f.runner.createWorkspace({ ...f.context, phase: "baseline" });
    const result = await f.runner.runBaseline({ ...f.context, workspace });
    expect(result.status).toBe("timed-out");
    expect(captureText(f.store.get(result.evidenceIds[0])!.content)).toBe("partial output before deadline");
    expect(result.reproduced).toBe(false);
  });

  it("removes owned resources with an independent signal after workload cancellation", async () => {
    const f = setup();
    const workspace = await f.runner.createWorkspace({ ...f.context, phase: "baseline" });
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await f.runner.cleanup({ ...f.context, signal: cancelled.signal, workspaces: [workspace] })).toEqual({ cleaned: true });
    const removal = f.process.calls.find((call) => call.args[0] === "rm")!;
    expect(removal.options.signal).not.toBe(cancelled.signal);
    expect(removal.options.signal?.aborted).toBe(false);
    await expect(f.runner.runBaseline({ ...f.context, workspace })).rejects.toThrow("WORKSPACE_NOT_AVAILABLE");
  });

  it.each(["exit", "timeout", "cancelled", "throw", "stuck"])("fails closed for %s cleanup uncertainty", async (mode) => {
    const f = setup({ cleanupTimeoutMs: 10 });
    const workspace = await f.runner.createWorkspace({ ...f.context, phase: "baseline" });
    f.process.hook = (call) => {
      if (call.args[0] !== "rm") return undefined;
      if (mode === "throw") throw new Error("transport disconnected");
      if (mode === "stuck") return new Promise(() => undefined);
      return mode === "exit" ? failure("remove failed") : { ...success(), ...(mode === "timeout" ? { timedOut: true } : { cancelled: true }) };
    };
    await expect(f.runner.cleanup({ ...f.context, workspaces: [workspace] })).rejects.toThrow("CLEANUP_FAILED");
  });

  it("cleans up a failed allocation even when the orchestrator has no returned handle", async () => {
    const f = setup();
    f.process.hook = (call) => call.args[0] === "start" ? failure("cannot start") : undefined;
    await expect(f.runner.createWorkspace({ ...f.context, phase: "baseline" })).rejects.toThrow("DOCKER_SETUP_FAILED");
    expect(f.process.calls.filter((call) => call.args[0] === "rm")).toHaveLength(1);
    expect(await f.runner.cleanup({ ...f.context, workspaces: [] })).toEqual({ cleaned: true });
  });

  it("uses the preselected name to remove an uncertain create and refuses successful cleanup claims", async () => {
    const f = setup();
    f.process.hook = (call) => call.args[0] === "create" ? { ...success(), timedOut: true } : undefined;
    await expect(f.runner.createWorkspace({ ...f.context, phase: "baseline" })).rejects.toThrow("CLEANUP_FAILED");
    const create = f.process.calls.find((call) => call.args[0] === "create")!;
    const name = create.args[create.args.indexOf("--name") + 1];
    expect(f.process.calls.some((call) => call.args[0] === "rm" && call.args.includes(name))).toBe(true);
    await expect(f.runner.cleanup({ ...f.context, workspaces: [] })).rejects.toThrow("CLEANUP_FAILED");
  });

  it("persists evidence compatible with the durable store and reads it back after reopening", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rift-staged-evidence-test-"));
    try {
      const path = join(directory, "evidence.jsonl");
      const store = new LocalEvidenceStore(path);
      const f = setup({ evidenceStore: store });
      const workspace = await f.runner.createWorkspace({ ...f.context, phase: "baseline" });
      const outcome = await f.runner.runBaseline({ ...f.context, workspace });
      expect(new LocalEvidenceStore(path).get(outcome.evidenceIds[0])).toEqual(store.get(outcome.evidenceIds[0]));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("fails closed before applying if evidence persistence fails", async () => {
    const store = new InMemoryEvidenceStore();
    const f = setup({ evidenceStore: { get: (id) => store.get(id), list: (query) => store.list(query), append: (item) => {
      if (item.source.locator.endsWith("/patch-intent")) throw new Error("disk full");
      return store.append(item);
    } } });
    const workspace = await reproduced(f);
    const request = patchRequest(f, workspace);
    await expect(f.runner.applyPatch(request)).rejects.toThrow("disk full");
    await expect(f.runner.applyPatch(request)).rejects.toThrow("PATCH_ALREADY_ATTEMPTED");
    expect(f.process.calls.some((call) => call.args.includes("apply"))).toBe(false);
  });

  it("does not run checks or reapply when evidence persistence fails after the actual apply", async () => {
    const store = new InMemoryEvidenceStore();
    const f = setup({ evidenceStore: { get: (id) => store.get(id), list: (query) => store.list(query), append: (item) => {
      if (item.source.locator.endsWith("/patch-apply")) throw new Error("disk full after apply");
      return store.append(item);
    } } });
    const workspace = await reproduced(f);
    const request = patchRequest(f, workspace);
    const outcome = await f.runner.applyPatch(request);
    expect(outcome.applied).toBe(false);
    expect(outcome.failureCode).toBe("PATCH_EXECUTION_UNCERTAIN");
    expect(await f.runner.applyPatch(request)).toEqual(outcome);
    await expect(f.runner.runChecks({ ...f.context, workspace })).rejects.toThrow("PATCH_NOT_APPLIED");
    expect(f.process.calls.filter((call) => call.args.includes("apply") && !call.args.includes("--check"))).toHaveLength(1);
  });

  it("requires an immutable image and an explicit nonempty failure signature", () => {
    const options: StagedDockerRunnerOptions = { repositoryPath: "/fixture/repo", repository: "rift-demo", image: IMAGE,
      evidenceStore: new InMemoryEvidenceStore(), expectedBaselineFailure: { code: "EXPECTED", signature: SIGNATURE } };
    expect(() => new StagedDockerVerificationRunner({ ...options, image: "runner:stable" })).toThrow("INVALID_RUNNER_CONFIGURATION");
    expect(() => new StagedDockerVerificationRunner({ ...options, expectedBaselineFailure: { code: "EXPECTED", signature: " " } })).toThrow("EXPECTED_BASELINE_SIGNATURE_REQUIRED");
    expect(() => new StagedDockerVerificationRunner({ ...options, offlineDependencies: [{ imagePath: "/workspace/from-host", workspacePath: "demo/node_modules" }] })).toThrow("INVALID_OFFLINE_DEPENDENCY");
  });
});

describe("BoundedStagedProcessRunner", () => {
  it("drains large stdout/stderr while keeping a bounded prefix", async () => {
    const process = new BoundedStagedProcessRunner(128);
    const result = await process.run("node", ["-e", "process.stdout.write('a'.repeat(100000));process.stderr.write('b'.repeat(100000))"], { timeoutMs: 1000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBe(128);
    expect(result.stderr.length).toBe(128);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
  });
});
