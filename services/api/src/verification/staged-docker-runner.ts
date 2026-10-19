import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix } from "node:path";
import type { CommandSpec, EvidenceItem, IncidentManifest, JsonValue, VerificationPlan } from "@rift/core";
import { validateCandidatePatch, validateEvidenceItem, validateIncidentManifest, validateVerificationPlan } from "@rift/core";
import type { EvidenceStore } from "../domain/evidence-store.js";
import { canonicalJson, computeEvidenceHash, sha256 } from "../domain/hashing.js";
import { redactSecrets } from "../domain/redaction.js";
import { SpawnProcessRunner, type ProcessResult, type ProcessRunner, type ProcessRunOptions } from "./docker-runner.js";
import type { ChecksOutcome, CommandOutcome, PatchOutcome, VerificationRunner, VerificationWorkspace } from "./ports.js";

type Request<K extends keyof VerificationRunner> = Parameters<VerificationRunner[K]>[0] & {
  readonly effectiveAuthorizedPaths?: readonly string[];
};
interface BoundedResult extends ProcessResult {
  readonly stdoutTruncated?: boolean;
  readonly stderrTruncated?: boolean;
}

export interface StagedDockerRunnerOptions {
  /** Local read-only git object source, bound to the manifest's repository name. */
  readonly repositoryPath: string;
  readonly repository: string;
  /** Immutable reviewed image, e.g. registry/runner@sha256:<64 hex digits>. Never pulled by this adapter. */
  readonly image: string;
  readonly evidenceStore: EvidenceStore;
  /** Literal, case-sensitive match in retained, redacted output; never inferred from exit status alone. */
  readonly expectedBaselineFailure: {
    readonly code: string;
    readonly signature: string;
    readonly stream?: "stdout" | "stderr" | "either";
  };
  readonly docker?: ProcessRunner;
  readonly host?: ProcessRunner;
  readonly dockerExecutable?: string;
  readonly cleanupTimeoutMs?: number;
  readonly captureLimitBytes?: number;
  readonly archiveLimitBytes?: number;
  readonly redactValues?: readonly string[];
  /** Copy directories already installed in the reviewed image. No installers or host mounts are used. */
  readonly offlineDependencies?: readonly {
    readonly imagePath: string;
    readonly workspacePath: string;
  }[];
}

interface WorkspaceState {
  readonly workspace: VerificationWorkspace;
  readonly run: RunState;
  readonly directory: string;
  ready: boolean;
  createSent: boolean;
  createUncertain: boolean;
  createInFlight?: boolean;
  removed: boolean;
  baselineStarted?: boolean;
  baseline?: CommandOutcome;
  checksStarted?: boolean;
  checks?: ChecksOutcome;
  patchApplied?: boolean;
}

interface RunState {
  readonly runId: string;
  readonly correlationId: string;
  readonly manifest: IncidentManifest;
  readonly plan: VerificationPlan;
  readonly effectiveAuthorizedPaths: readonly string[];
  readonly workspaces: WorkspaceState[];
  reproduced: boolean;
  closing: boolean;
  failed: boolean;
  patchAttempted: boolean;
  patchFingerprint?: string;
  patchOutcome?: PatchOutcome;
}

export class StagedDockerRunnerError extends Error {
  public constructor(public readonly code: string) { super(code); this.name = "StagedDockerRunnerError"; }
}

/**
 * Staged VerificationRunner. Each phase gets an independent, non-root, networkless
 * tmpfs container populated exclusively from allowed paths of a full pinned commit.
 * State is deliberately not recoverable by retry after an uncertain side effect.
 * Keep this instance alive for the lifetime of its VerificationOrchestrator.
 */
export class StagedDockerVerificationRunner implements VerificationRunner {
  private readonly options: StagedDockerRunnerOptions;
  private readonly docker: ProcessRunner;
  private readonly host: ProcessRunner;
  private readonly runs = new Map<string, RunState>();
  private readonly workspaces = new Map<string, WorkspaceState>();

  public constructor(options: StagedDockerRunnerOptions) {
    if (!isAbsolute(options.repositoryPath) || !options.repository.trim() ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/u.test(options.image) || options.image.length > 256) fail("INVALID_RUNNER_CONFIGURATION");
    const expected = options.expectedBaselineFailure;
    if (!expected || !/^[A-Za-z0-9_-]{1,128}$/u.test(expected.code) || !expected.signature.trim() || expected.signature.length > 512 ||
        (expected.stream !== undefined && !["stdout", "stderr", "either"].includes(expected.stream))) fail("EXPECTED_BASELINE_SIGNATURE_REQUIRED");
    positiveLimit(options.cleanupTimeoutMs ?? 5_000, 120_000);
    positiveLimit(options.captureLimitBytes ?? 65_536, 131_072);
    positiveLimit(options.archiveLimitBytes ?? 67_108_864, 268_435_456);
    for (const dependency of options.offlineDependencies ?? []) {
      if (!dependency.imagePath.startsWith("/") || !safeRelative(dependency.imagePath.slice(1)) ||
          dependency.imagePath === "/workspace" || dependency.imagePath.startsWith("/workspace/") ||
          dependency.imagePath === "/tmp" || dependency.imagePath.startsWith("/tmp/") || !safeRelative(dependency.workspacePath)) fail("INVALID_OFFLINE_DEPENDENCY");
    }
    this.options = { ...options, expectedBaselineFailure: { ...expected },
      offlineDependencies: options.offlineDependencies?.map((dependency) => ({ ...dependency })), redactValues: [...(options.redactValues ?? [])] };
    this.docker = options.docker ?? new BoundedStagedProcessRunner(131_072);
    this.host = options.host ?? new BoundedStagedProcessRunner(options.archiveLimitBytes ?? 67_108_864);
  }

  public async createWorkspace(request: Request<"createWorkspace">): Promise<VerificationWorkspace> {
    this.validateContext(request.manifest, request.plan, request.correlationId, request.effectiveAuthorizedPaths);
    if (!["baseline", "patched"].includes(request.phase) || !/^[A-Za-z0-9_-]{1,128}$/u.test(request.runId)) fail("INVALID_WORKSPACE_REQUEST");
    if (request.signal.aborted) fail("CANCELLED");
    let run = this.runs.get(request.runId);
    if (run) this.assertContext(run, request);
    else {
      run = { runId: request.runId, correlationId: request.correlationId, manifest: copy(request.manifest), plan: copy(request.plan), effectiveAuthorizedPaths: [...effectiveScope(request.manifest, request.effectiveAuthorizedPaths)],
        workspaces: [], reproduced: false, closing: false, failed: false, patchAttempted: false };
      this.runs.set(request.runId, run);
    }
    if (run.closing || run.failed || run.workspaces.some((item) => item.workspace.phase === request.phase)) fail("WORKSPACE_ALREADY_ATTEMPTED");
    if (request.phase === "patched" && !run.reproduced) fail("BASELINE_NOT_REPRODUCED");
    const directory = await mkdtemp(join(tmpdir(), "rift-staged-"));
    const workspace = Object.freeze({ id: `rift-verify-${randomUUID()}-${request.phase}`, phase: request.phase });
    const state: WorkspaceState = { workspace, run, directory, ready: false, createSent: false, createUncertain: false, removed: false };
    // Register ownership before any Docker action, including a create whose reply may be lost.
    run.workspaces.push(state);
    this.workspaces.set(workspace.id, state);
    try {
      if (run.closing) fail("WORKSPACE_NOT_AVAILABLE");
      const revision = run.plan.baseRevision.revision;
      const gitArgs = ["--no-replace-objects", "--literal-pathspecs", "-C", this.options.repositoryPath];
      const resolved = await this.invoke(this.host, "git", [...gitArgs, "rev-parse", "--verify", `${revision}^{commit}`], request.signal, run.plan.timeoutMs);
      if (!completed(resolved) || resolved.stdout.toString("utf8").trim() !== revision) fail("BASE_REVISION_NOT_FOUND");
      const paths = run.effectiveAuthorizedPaths;
      const tree = await this.invoke(this.host, "git", [...gitArgs, "ls-tree", "-rz", "-r", "--full-tree", revision, "--", ...paths], request.signal, run.plan.timeoutMs);
      if (!completed(tree) || tree.stdoutTruncated || tree.stdout.length >= (this.options.archiveLimitBytes ?? 67_108_864)) fail("UNSAFE_SOURCE_TREE");
      validateTree(tree.stdout, paths);
      const archive = await this.invoke(this.host, "git", [...gitArgs, "archive", "--format=tar", revision, "--", ...paths], request.signal, run.plan.timeoutMs);
      if (!completed(archive) || !archive.stdout.length || archive.stdoutTruncated || archive.stdout.length >= (this.options.archiveLimitBytes ?? 67_108_864)) fail("ARCHIVE_FAILED_OR_TOO_LARGE");
      const archivePath = join(directory, "source.tar");
      // The enclosing directory is 0700. Container's unprivileged user must read the copied file.
      await writeFile(archivePath, archive.stdout, { mode: 0o644 });
      if (run.closing || request.signal.aborted) fail("CANCELLED");
      state.createSent = true;
      state.createInFlight = true;
      let created: BoundedResult;
      try {
        created = await this.dockerCall(["create", "--name", workspace.id, "--pull", "never", "--network", "none", "--read-only",
          "--user", "65532:65532", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--ipc", "none",
          "--pids-limit", "128", "--memory", "512m", "--cpus", "1", "--ulimit", "nofile=1024:1024",
          "--tmpfs", "/workspace:rw,nosuid,nodev,mode=1777,size=512m", "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777,size=64m",
          "--label", "rift.verification=disposable", "--entrypoint", "/bin/sh", this.options.image, "-c", "while :; do sleep 3600; done"], request.signal, run.plan.timeoutMs);
      } catch (error) { state.createUncertain = true; throw error; }
      finally { state.createInFlight = false; }
      if (!completed(created)) { state.createUncertain = true; fail("CONTAINER_CREATE_UNCERTAIN"); }
      if (run.closing) fail("WORKSPACE_NOT_AVAILABLE");
      await this.requireDocker(["start", workspace.id], request.signal, run.plan.timeoutMs);
      await this.requireDocker(["cp", archivePath, `${workspace.id}:/tmp/rift-source.tar`], request.signal, run.plan.timeoutMs);
      await this.requireDocker(["exec", workspace.id, "tar", "--no-same-owner", "--no-same-permissions", "-xf", "/tmp/rift-source.tar", "-C", "/workspace"], request.signal, run.plan.timeoutMs);
      for (const dependency of this.options.offlineDependencies ?? []) {
        if (!inScope(dependency.workspacePath, paths)) fail("DEPENDENCY_PATH_NOT_ALLOWED");
        const target = posix.join("/workspace", dependency.workspacePath);
        await this.requireDocker(["exec", workspace.id, "mkdir", "-p", "--", posix.dirname(target)], request.signal, run.plan.timeoutMs);
        await this.requireDocker(["exec", workspace.id, "test", "!", "-e", target], request.signal, run.plan.timeoutMs);
        await this.requireDocker(["exec", workspace.id, "cp", "-R", "--", dependency.imagePath, target], request.signal, run.plan.timeoutMs);
      }
      state.ready = true;
      return workspace;
    } catch (error) {
      run.failed = true;
      try { await this.removeOwned([state]); } catch { fail("CLEANUP_FAILED"); }
      throw error;
    }
  }

  public async runBaseline(request: Request<"runBaseline">): Promise<CommandOutcome> {
    const state = this.owned(request, "baseline");
    if (canonicalJson(request.manifest as unknown as JsonValue) !== canonicalJson(state.run.manifest as unknown as JsonValue)) fail("MANIFEST_MISMATCH");
    if (state.baseline) return state.baseline;
    if (state.baselineStarted) fail("BASELINE_ALREADY_ATTEMPTED");
    state.baselineStarted = true;
    const { outcome, stdout, stderr } = await this.execute(state, state.run.plan.baselineCommand, "baseline", request.signal);
    const expected = this.options.expectedBaselineFailure;
    const matches = (expected.stream !== "stderr" && stdout.includes(expected.signature)) || (expected.stream !== "stdout" && stderr.includes(expected.signature));
    const reproduced = outcome.status === "failed" && outcome.exitCode !== null && outcome.exitCode > 0 && matches;
    state.run.reproduced = reproduced;
    state.baseline = Object.freeze({ ...outcome, reproduced, ...(reproduced ? { failureCode: expected.code } : {}) });
    return state.baseline;
  }

  public async applyPatch(request: Request<"applyPatch">): Promise<PatchOutcome> {
    const state = this.owned(request, "patched");
    const run = state.run;
    const patch = request.patch;
    if (request.applicationOrdinal !== 1 || !/^sha256:[0-9a-f]{64}$/u.test(request.idempotencyKey)) fail("INVALID_PATCH_APPLICATION");
    if (!run.reproduced) fail("BASELINE_NOT_REPRODUCED");
    if (patch.incidentId !== run.manifest.incidentId || patch.correlationId !== run.correlationId || patch.id !== run.plan.candidatePatchId || !sameRevision(patch.baseRevision, run.plan.baseRevision)) fail("PATCH_CONTEXT_MISMATCH");
    if (patch.contentHash !== candidatePatchContentHash(patch)) fail("PATCH_CONTENT_HASH_MISMATCH");
    // Shared validator parses the actual diff, reconciles touchedPaths and rejects protected paths/modes.
    if (!validateCandidatePatch(patch, { allowedPaths: run.effectiveAuthorizedPaths }).ok) fail("PATCH_VALIDATION_FAILED");
    const fingerprint = sha256({ idempotencyKey: request.idempotencyKey, patch: patch as unknown as JsonValue, workspace: state.workspace.id });
    if (run.patchAttempted) {
      if (run.patchFingerprint === fingerprint && run.patchOutcome) return run.patchOutcome;
      fail("PATCH_ALREADY_ATTEMPTED");
    }
    run.patchAttempted = true;
    run.patchFingerprint = fingerprint;
    // A durable intent precedes both check and apply. A new adapter cannot silently replay this run's patch.
    const receiptId = `patch-${sha256({ runId: run.runId, correlationId: run.correlationId }).slice(7)}`;
    if (this.options.evidenceStore.get(receiptId)) fail("PATCH_ALREADY_ATTEMPTED");
    this.append(state, "patch-intent", { receiptId, fingerprint, applicationOrdinal: 1 }, receiptId);
    const evidenceIds = [receiptId];
    try {
      const patchPath = join(state.directory, "candidate.patch");
      await writeFile(patchPath, patch.diff, { mode: 0o644 });
      await this.requireDocker(["cp", patchPath, `${state.workspace.id}:/tmp/rift-candidate.patch`], request.signal, run.plan.timeoutMs);
      for (const check of [true, false]) {
        const output = await this.dockerCall(["exec", state.workspace.id, "git", "-C", "/workspace", "apply", "--no-index", ...(check ? ["--check"] : []), "--", "/tmp/rift-candidate.patch"], request.signal, run.plan.timeoutMs);
        const capture = this.capture(state, check ? "patch-check" : "patch-apply", output);
        evidenceIds.push(capture.id);
        if (!completed(output)) {
          run.patchOutcome = Object.freeze({ applied: false, receiptId, evidenceIds: Object.freeze([...evidenceIds]), failureCode: output.timedOut || output.cancelled || output.exitCode === null ? "PATCH_EXECUTION_UNCERTAIN" : "PATCH_FAILED" });
          return run.patchOutcome;
        }
      }
      state.patchApplied = true;
      run.patchOutcome = Object.freeze({ applied: true, receiptId, evidenceIds: Object.freeze([...evidenceIds]) });
      return run.patchOutcome;
    } catch {
      // Never attempt a second application after I/O, evidence persistence or transport uncertainty.
      run.patchOutcome = Object.freeze({ applied: false, receiptId, evidenceIds: Object.freeze([...evidenceIds]), failureCode: "PATCH_EXECUTION_UNCERTAIN" });
      return run.patchOutcome;
    }
  }

  public async runChecks(request: Request<"runChecks">): Promise<ChecksOutcome> {
    const state = this.owned(request, "patched");
    if (!state.run.reproduced || !state.patchApplied) fail("PATCH_NOT_APPLIED");
    if (state.checks) return state.checks;
    if (state.checksStarted) fail("CHECKS_ALREADY_ATTEMPTED");
    state.checksStarted = true;
    const executions: CommandOutcome[] = [];
    for (const command of state.run.plan.verificationCommands) executions.push((await this.execute(state, command, "checks", request.signal)).outcome);
    state.checks = Object.freeze({ executions: Object.freeze(executions) });
    return state.checks;
  }

  public async cleanup(request: Request<"cleanup">): Promise<{ cleaned: true }> {
    const run = this.runs.get(request.runId);
    if (!run) {
      if (request.workspaces.length) fail("UNKNOWN_WORKSPACE");
      return { cleaned: true };
    }
    if (run.correlationId !== request.correlationId) fail("CORRELATION_ID_MISMATCH");
    for (const workspace of request.workspaces) {
      const state = this.workspaces.get(workspace.id);
      if (!state || state.run !== run || state.workspace.phase !== workspace.phase) fail("WORKSPACE_CONTEXT_MISMATCH");
    }
    run.closing = true;
    // Include allocations whose createWorkspace threw before the orchestrator could record its handle.
    // Never inherit a workload cancellation signal; removal has its own bounded lifetime.
    await this.removeOwned(run.workspaces);
    return { cleaned: true };
  }

  private validateContext(manifest: IncidentManifest, plan: VerificationPlan, correlationId: string, requestedScope?: readonly string[]): void {
    if (!validateIncidentManifest(manifest).ok || !validateVerificationPlan(plan).ok) fail("INVALID_VERIFICATION_INPUT");
    if (manifest.incidentId !== plan.incidentId || correlationId !== manifest.correlationId || correlationId !== plan.correlationId) fail("INCIDENT_OR_CORRELATION_MISMATCH");
    if (manifest.repositoryRevision.repository !== this.options.repository || !sameRevision(manifest.repositoryRevision, plan.baseRevision) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(plan.baseRevision.revision)) fail("BASE_REVISION_MISMATCH");
    if (manifest.policy.networkAccess !== "disabled" || plan.networkAccess !== "disabled") fail("NETWORK_MUST_BE_DISABLED");
    if (this.captureBudget(manifest) < 4096) fail("EVIDENCE_BUDGET_TOO_SMALL");
    if (!sameCommand(plan.baselineCommand, manifest.reproductionCommand) || plan.verificationCommands.length === 0 ||
        plan.verificationCommands.length !== manifest.testCommands.length || plan.verificationCommands.some((command, index) => !sameCommand(command, manifest.testCommands[index]))) fail("COMMAND_NOT_AUTHORIZED");
    for (const command of [plan.baselineCommand, ...plan.verificationCommands]) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(command.command) || !manifest.policy.allowedCommands?.includes(command.command) ||
          (command.workingDirectory !== undefined && command.workingDirectory !== "." && !safeRelative(command.workingDirectory))) fail("COMMAND_NOT_AUTHORIZED");
    }
    if (manifest.allowedPaths.some((path) => !safeRelative(path) || path.split("/").includes(".git"))) fail("PATH_NOT_ALLOWED");
    const scope = effectiveScope(manifest, requestedScope);
    for (const dependency of this.options.offlineDependencies ?? []) if (!inScope(dependency.workspacePath, scope)) fail("DEPENDENCY_PATH_NOT_ALLOWED");
  }

  private assertContext(run: RunState, request: { correlationId: string; plan: VerificationPlan; manifest?: IncidentManifest; effectiveAuthorizedPaths?: readonly string[] }): void {
    if (request.correlationId !== run.correlationId || !equalJson(request.plan, run.plan) || (request.manifest && !equalJson(request.manifest, run.manifest)) ||
        (request.effectiveAuthorizedPaths && !equalJson(request.effectiveAuthorizedPaths, run.effectiveAuthorizedPaths))) fail("WORKSPACE_CONTEXT_MISMATCH");
  }

  private owned(request: { runId: string; correlationId: string; plan: VerificationPlan; workspace: VerificationWorkspace; signal: AbortSignal }, phase: VerificationWorkspace["phase"]): WorkspaceState {
    const state = this.workspaces.get(request.workspace.id);
    if (!state || state.run.runId !== request.runId || request.workspace.phase !== phase || state.workspace.phase !== phase) fail("WORKSPACE_CONTEXT_MISMATCH");
    this.assertContext(state.run, request);
    if (!state.ready || state.removed || state.run.closing || state.run.failed) fail("WORKSPACE_NOT_AVAILABLE");
    if (request.signal.aborted) fail("CANCELLED");
    return state;
  }

  private async execute(state: WorkspaceState, command: CommandSpec, operation: string, signal: AbortSignal): Promise<{ outcome: CommandOutcome; stdout: string; stderr: string }> {
    const args = ["exec", "-w", posix.join("/workspace", command.workingDirectory ?? "."), "--env", "RIFT_NETWORK=disabled"];
    for (const [key, value] of Object.entries(command.environment ?? {})) args.push("--env", `${key}=${value}`);
    args.push(state.workspace.id, command.command, ...(command.args ?? []));
    const startedAt = new Date().toISOString();
    let output: BoundedResult;
    try { output = await this.dockerCall(args, signal, state.run.plan.timeoutMs); }
    catch { output = { exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), ...(signal.aborted ? { cancelled: true } : {}) }; }
    const status = commandStatus(output);
    const capture = this.capture(state, operation, output, startedAt, sha256(command as unknown as JsonValue));
    return { outcome: Object.freeze({ status, exitCode: status === "timed-out" || status === "cancelled" ? null : output.exitCode,
      evidenceIds: Object.freeze([capture.id]), ...(status === "timed-out" || status === "cancelled" || output.exitCode === null ? { failureCode: "COMMAND_EXECUTION_UNCERTAIN" } : {}) }), stdout: capture.stdout, stderr: capture.stderr };
  }

  private capture(state: WorkspaceState, operation: string, result: BoundedResult, startedAt = new Date().toISOString(), commandHash = ""): { id: string; stdout: string; stderr: string } {
    // Worst-case JSON escaping is six bytes per input byte. Reserve room for capture metadata.
    const streamBudget = Math.floor((this.captureBudget(state.run.manifest) - 2048) / 12);
    const secrets = [...(this.options.redactValues ?? []), ...[state.run.plan.baselineCommand, ...state.run.plan.verificationCommands]
      .flatMap((command) => Object.entries(command.environment ?? {}).filter(([key]) => /secret|password|token|credential|api.?key|authorization/iu.test(key)).map(([, value]) => value))].filter(Boolean);
    const clean = (buffer: Buffer): { text: string; redacted: boolean; rules: readonly string[] } => {
      let text = buffer.subarray(0, streamBudget).toString("utf8");
      let literalRedacted = false;
      for (const secret of secrets) {
        if (text.includes(secret)) { text = text.split(secret).join("[REDACTED]"); literalRedacted = true; }
        // A bounded stream can end part-way through a configured secret.
        if (buffer.length > streamBudget) for (let length = Math.min(secret.length - 1, text.length); length > 0; length--) {
          if (text.endsWith(secret.slice(0, length))) { text = `${text.slice(0, -length)}[REDACTED]`; literalRedacted = true; break; }
        }
      }
      // Also redact an unterminated private key cut off by the capture boundary.
      if (/-----BEGIN [^-]*PRIVATE KEY-----/u.test(text) && !/-----END [^-]*PRIVATE KEY-----/u.test(text)) {
        text = text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*/u, "[REDACTED]"); literalRedacted = true;
      }
      const redacted = redactSecrets(text);
      return { text: Buffer.from(redacted.value as string).subarray(0, streamBudget).toString("utf8"), redacted: literalRedacted || redacted.redacted,
        rules: [...redacted.rules, ...(literalRedacted ? ["configured-value-or-partial-key"] : [])] };
    };
    const stdout = clean(result.stdout), stderr = clean(result.stderr);
    // Shared JsonValue validation forbids control characters in strings. Base64
    // retains redacted newlines/tabs/ANSI bytes without rewriting the raw capture.
    const id = this.append(state, operation, { status: commandStatus(result), exitCode: result.exitCode, encoding: "base64", textEncoding: "utf8",
      stdout: Buffer.from(stdout.text).toString("base64"), stderr: Buffer.from(stderr.text).toString("base64"),
      stdoutBytes: result.stdoutBytes ?? result.stdout.length, stderrBytes: result.stderrBytes ?? result.stderr.length,
      stdoutTruncated: Boolean(result.stdoutTruncated || (result.stdoutBytes ?? result.stdout.length) > streamBudget),
      stderrTruncated: Boolean(result.stderrTruncated || (result.stderrBytes ?? result.stderr.length) > streamBudget), startedAt, finishedAt: new Date().toISOString(), commandHash }, undefined,
    stdout.redacted || stderr.redacted, [...new Set([...stdout.rules, ...stderr.rules])]);
    return { id, stdout: stdout.text, stderr: stderr.text };
  }

  private append(state: WorkspaceState, operation: string, content: JsonValue, id = `evidence-${randomUUID()}`, redacted = false, rules: readonly string[] = []): string {
    const timestamp = new Date().toISOString();
    const withoutHash: Omit<EvidenceItem, "contentHash"> = { kind: "EvidenceItem", schemaVersion: 1, id,
      incidentId: state.run.manifest.incidentId, correlationId: state.run.correlationId, createdAt: timestamp, capturedAt: timestamp, content,
      source: { type: "verification-docker-capture", locator: `docker://${state.workspace.id}/${operation}` },
      redaction: { status: redacted ? "redacted" : "not-required", rules }, provenance: { actor: "staged-docker-verification-runner", tool: "docker",
        metadata: { runId: state.run.runId, phase: state.workspace.phase, operation, image: this.options.image, revision: state.run.plan.baseRevision.revision } } };
    const item = { ...withoutHash, contentHash: computeEvidenceHash(withoutHash) };
    if (!validateEvidenceItem(item).ok) fail("INVALID_CAPTURE_EVIDENCE");
    const stored = this.options.evidenceStore.append(item);
    if (stored.id !== item.id || stored.contentHash !== item.contentHash || this.options.evidenceStore.get(item.id)?.contentHash !== item.contentHash) fail("EVIDENCE_PERSISTENCE_UNCERTAIN");
    return stored.id;
  }

  private captureBudget(manifest: IncidentManifest): number { return Math.min(this.options.captureLimitBytes ?? 65_536, manifest.policy.maxEvidenceBytes ?? 65_536); }

  private async removeOwned(states: readonly WorkspaceState[]): Promise<void> {
    const controller = new AbortController();
    const timeout = this.options.cleanupTimeoutMs ?? 5_000;
    const timer = setTimeout(() => controller.abort(), timeout);
    let failed = false;
    try {
      for (const state of states) {
        if (state.createInFlight) state.createUncertain = true;
        if (state.removed) { failed ||= state.createUncertain; continue; }
        let containerRemoved = !state.createSent;
        if (state.createSent) {
          try {
            const output = await this.dockerCall(["rm", "--force", "--volumes", state.workspace.id], controller.signal, timeout);
            containerRemoved = completed(output);
            failed ||= !containerRemoved;
          } catch { failed = true; }
        }
        // Local captures/patch files can be removed even if Docker removal is uncertain.
        try { await rm(state.directory, { recursive: true, force: true }); state.removed = containerRemoved; state.ready = false; }
        catch { failed = true; }
        failed ||= state.createUncertain;
      }
    } finally { clearTimeout(timer); }
    if (failed || controller.signal.aborted) fail("CLEANUP_FAILED");
  }

  private async requireDocker(args: readonly string[], signal: AbortSignal, timeoutMs: number): Promise<void> {
    if (!completed(await this.dockerCall(args, signal, timeoutMs))) fail("DOCKER_SETUP_FAILED");
  }

  private dockerCall(args: readonly string[], signal: AbortSignal, timeoutMs: number): Promise<BoundedResult> {
    return this.invoke(this.docker, this.options.dockerExecutable ?? "docker", args, signal, timeoutMs);
  }

  /** Bound even an injected transport that ignores cancellation; uncertainty is never success. */
  private async invoke(runner: ProcessRunner, executable: string, args: readonly string[], signal: AbortSignal, timeoutMs: number): Promise<BoundedResult> {
    if (signal.aborted) return { exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), cancelled: true };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    let timedOut = false, cancelled = false;
    const stopped = new Promise<BoundedResult>((resolve) => {
      const stop = (wasCancelled: boolean): void => {
        if (controller.signal.aborted) return;
        cancelled = wasCancelled; timedOut = !wasCancelled;
        controller.abort();
        // Let a cooperative transport close and return its partial captures before
        // falling back to an uncertain, empty capture from a stuck transport.
        graceTimer = setTimeout(() => resolve({ exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), cancelled, timedOut }), 100);
      };
      abort = () => stop(true);
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => stop(false), timeoutMs);
    });
    try {
      const result = await Promise.race([runner.run(executable, args, { signal: controller.signal, timeoutMs }), stopped]);
      return timedOut || cancelled ? { ...result, timedOut, cancelled, exitCode: null } : result;
    } finally { if (timer) clearTimeout(timer); if (graceTimer) clearTimeout(graceTimer); if (abort) signal.removeEventListener("abort", abort); }
  }
}

/** SpawnProcessRunner's injectable API, with bounded draining captures and close-based cancellation. */
export class BoundedStagedProcessRunner extends SpawnProcessRunner {
  public constructor(private readonly limitBytes = 131_072) { super(); positiveLimit(limitBytes, 268_435_456); }
  public override run(command: string, args: readonly string[], options: ProcessRunOptions = {}): Promise<BoundedResult> {
    if (options.signal?.aborted) return Promise.resolve({ exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), cancelled: true });
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      let stdoutBytes = 0, stderrBytes = 0, stdoutTruncated = false, stderrTruncated = false, timedOut = false, cancelled = false;
      child.stdout.on("data", (data: Buffer) => { const kept = data.subarray(0, Math.max(0, this.limitBytes - stdoutBytes)); if (kept.length) stdout.push(Buffer.from(kept)); stdoutBytes += data.length; stdoutTruncated ||= kept.length !== data.length; });
      child.stderr.on("data", (data: Buffer) => { const kept = data.subarray(0, Math.max(0, this.limitBytes - stderrBytes)); if (kept.length) stderr.push(Buffer.from(kept)); stderrBytes += data.length; stderrTruncated ||= kept.length !== data.length; });
      const abort = (): void => { cancelled = true; child.kill("SIGKILL"); };
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs) : undefined;
      const dispose = (): void => { if (timer) clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
      child.on("error", (error) => { dispose(); reject(error); });
      child.on("close", (exitCode) => { dispose(); resolve({ exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), stdoutBytes, stderrBytes, stdoutTruncated, stderrTruncated, timedOut, cancelled }); });
    });
  }
}

function fail(code: string): never { throw new StagedDockerRunnerError(code); }
function positiveLimit(value: number, max: number): void { if (!Number.isSafeInteger(value) || value <= 0 || value > max) fail("INVALID_RUNNER_LIMIT"); }
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function equalJson(left: unknown, right: unknown): boolean { return canonicalJson(left as JsonValue) === canonicalJson(right as JsonValue); }
function sameRevision(left: VerificationPlan["baseRevision"], right: VerificationPlan["baseRevision"]): boolean { return left.repository === right.repository && left.revision === right.revision; }
function sameCommand(left: CommandSpec, right: CommandSpec): boolean {
  return equalJson({ command: left.command, args: left.args ?? [], workingDirectory: left.workingDirectory ?? ".", environment: left.environment ?? {} },
    { command: right.command, args: right.args ?? [], workingDirectory: right.workingDirectory ?? ".", environment: right.environment ?? {} });
}
function completed(result: BoundedResult): boolean { return result.exitCode === 0 && !result.timedOut && !result.cancelled; }
function commandStatus(result: BoundedResult): CommandOutcome["status"] {
  return result.cancelled ? "cancelled" : result.timedOut ? "timed-out" : result.exitCode === 0 ? "succeeded" : result.exitCode === null ? "blocked" : "failed";
}
function safeRelative(path: string): boolean { return Boolean(path) && !/[\\\u0000-\u001f\u007f]/u.test(path) && !/^[A-Za-z]:/u.test(path) && path.split("/").every((part) => part !== "" && part !== "." && part !== ".."); }
function inScope(path: string, allowedPaths: readonly string[]): boolean { return allowedPaths.some((scope) => path === scope || path.startsWith(`${scope}/`)); }
function effectiveScope(manifest: IncidentManifest, requested?: readonly string[]): readonly string[] {
  const scope = requested ?? manifest.allowedPaths;
  if (scope.length === 0 || new Set(scope).size !== scope.length || scope.some((path) => !safeRelative(path) || path.split("/").includes(".git") || !inScope(path, manifest.allowedPaths))) fail("EFFECTIVE_SCOPE_MISMATCH");
  return [...scope];
}
function candidatePatchContentHash(patch: { readonly contentHash: string; }): string {
  const { contentHash: _contentHash, ...withoutHash } = patch as { readonly contentHash: string } & Record<string, unknown>;
  return sha256(withoutHash as JsonValue);
}
function validateTree(buffer: Buffer, allowedPaths: readonly string[]): void {
  const text = buffer.toString("utf8");
  if (!text.endsWith("\0") || !Buffer.from(text).equals(buffer)) fail("UNSAFE_SOURCE_TREE");
  const entries = text.slice(0, -1).split("\0");
  if (!entries.length) fail("EMPTY_SOURCE_TREE");
  for (const entry of entries) {
    const match = /^(100644|100755) blob [0-9a-f]{40,64}\t(.+)$/u.exec(entry);
    if (!match || !safeRelative(match[2]) || match[2].split("/").includes(".git") || !inScope(match[2], allowedPaths)) fail("UNSAFE_SOURCE_TREE");
  }
}
