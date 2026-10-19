import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, posix, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { CommandSpec, EvidenceItem, JsonValue, VerificationPlan, VerificationResult } from "@rift/core";
import { validateCandidatePatch, validateEvidenceItem, validateVerificationPlan, validateVerificationResult } from "@rift/core";
import type { EvidenceStore } from "../domain/evidence-store.js";
import { canonicalJson, computeEvidenceHash } from "../domain/hashing.js";
import { redactSecrets } from "../domain/redaction.js";
import {
  SandboxRunnerError,
  type SandboxCommandCapture,
  type SandboxCommandPhase,
  type SandboxCommandStatus,
  type SandboxRunRequest,
  type SandboxRunResult,
  type SandboxRunner,
} from "./sandbox-runner.js";

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly timedOut?: boolean;
  readonly cancelled?: boolean;
  readonly stdoutTruncated?: boolean;
  readonly stderrTruncated?: boolean;
  readonly stdoutBytes?: number;
  readonly stderrBytes?: number;
}

export interface ProcessRunOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Injectable boundary for both the Docker CLI and the read-only git archive. */
export interface ProcessRunner {
  run(command: string, args: readonly string[], options?: ProcessRunOptions): Promise<ProcessResult>;
}

export interface DockerSandboxRunnerOptions {
  /** Must identify a reviewed, pinned runner image. Tags other than `latest` are accepted for local fixtures. */
  readonly image: string;
  readonly allowedCommands?: readonly string[];
  readonly dockerExecutable?: string;
  readonly docker?: ProcessRunner;
  readonly host?: ProcessRunner;
  readonly memoryLimit?: string;
  readonly cpuLimit?: string;
  readonly pidsLimit?: number;
  readonly networkName?: string;
  readonly workspacePath?: string;
  /** Verification is unavailable without durable, readable capture evidence. */
  readonly evidenceStore?: EvidenceStore;
  /** Literal match in retained, redacted output from a completed nonzero baseline. */
  readonly expectedBaselineFailure?: {
    readonly code: string;
    readonly signature: string;
    readonly stream?: "stdout" | "stderr" | "either";
  };
  readonly captureLimitBytes?: number;
  readonly redactValues?: readonly string[];
}

const DEFAULT_ALLOWED_COMMANDS = Object.freeze([
  "bash",
  "cargo",
  "go",
  "make",
  "node",
  "npm",
  "pnpm",
  "pytest",
  "python",
  "python3",
  "sh",
  "yarn",
]);
const EMPTY_HASH = hashBytes(Buffer.alloc(0));

/**
 * Docker CLI implementation of the sandbox boundary. Source is transferred as
 * a git archive and a patch as a temporary file; neither is bind-mounted.
 */
export class DockerSandboxRunner implements SandboxRunner {
  private readonly docker: ProcessRunner;
  private readonly host: ProcessRunner;
  private readonly options: Required<Pick<DockerSandboxRunnerOptions, "image" | "dockerExecutable" | "workspacePath">> & DockerSandboxRunnerOptions;

  public constructor(options: DockerSandboxRunnerOptions) {
    if (options.image.trim() === "" || options.image.endsWith(":latest")) {
      throw new SandboxRunnerError("A non-latest pinned Docker image is required", "INVALID_INPUT");
    }
    const expected = options.expectedBaselineFailure;
    if (expected && (!/^[A-Za-z0-9_-]{1,128}$/u.test(expected.code) || !expected.signature.trim() || expected.signature.length > 512 ||
      (expected.stream !== undefined && !["stdout", "stderr", "either"].includes(expected.stream)))) {
      throw new SandboxRunnerError("A valid expected baseline failure code and signature are required", "INVALID_INPUT");
    }
    if (!Number.isSafeInteger(options.captureLimitBytes ?? 65_536) || (options.captureLimitBytes ?? 65_536) < 256 || (options.captureLimitBytes ?? 65_536) > 131_072) {
      throw new SandboxRunnerError("Capture limit must be between 256 and 131072 bytes", "INVALID_INPUT");
    }
    this.options = {
      ...options,
      image: options.image,
      dockerExecutable: options.dockerExecutable ?? "docker",
      workspacePath: options.workspacePath ?? "/workspace",
      ...(expected ? { expectedBaselineFailure: { ...expected } } : {}),
      redactValues: [...(options.redactValues ?? [])],
    };
    this.docker = options.docker ?? new SpawnProcessRunner();
    this.host = options.host ?? new SpawnProcessRunner(67_108_864);
  }

  public async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    this.validateRequest(request);
    const { candidatePatch: patch, verificationPlan: plan } = request;
    const allowedCommands = this.options.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS;
    const environmentFingerprint = this.fingerprint(request, allowedCommands);
    const tempDirectory = await mkdtemp(join(tmpdir(), "rift-sandbox-"));
    let containerId: string | undefined;
    let cleanupSucceeded = true;
    let baseline: SandboxCommandCapture | undefined;
    const verification: SandboxCommandCapture[] = [];
    const baselineEvidenceIds: string[] = [];
    const patchedEvidenceIds: string[] = [];
    let failure: { code: string; message: string } | undefined;
    let classification: VerificationResult["classification"] = "inconclusive";
    let baselineExitCode: number | null = null;
    let patchedExitCode: number | null = null;

    try {
      const archivePath = join(tempDirectory, "source.tar");
      const patchPath = join(tempDirectory, "candidate.patch");
      const archive = await this.host.run("git", ["--no-replace-objects", "-C", resolve(request.repositoryPath), "archive", "--format=tar", plan.baseRevision.revision], {
        timeoutMs: plan.timeoutMs,
        signal: request.signal,
      });
      if (archive.exitCode !== 0 || archive.timedOut || archive.cancelled || archive.stdoutTruncated || archive.stdout.byteLength === 0 || archive.stdout.byteLength > 67_108_864) {
        throw new SandboxRunnerError(
          `Unable to archive pinned revision ${plan.baseRevision.revision}`,
          "HOST_REPOSITORY",
        );
      }
      await writeFile(archivePath, archive.stdout, { mode: 0o600 });
      await writeFile(patchPath, patch.diff, { encoding: "utf8", mode: 0o600 });

      containerId = await this.createContainer(plan, request.signal);
      await this.requireDockerSuccess(["start", containerId], plan.timeoutMs, request.signal, "Docker could not start the sandbox");
      await this.requireDockerSuccess(["cp", archivePath, `${containerId}:/tmp/rift-source.tar`], plan.timeoutMs, request.signal, "Docker could not transfer the source archive");
      await this.execSetup(containerId, ["tar", "-xf", "/tmp/rift-source.tar", "-C", this.options.workspacePath], plan.timeoutMs, request.signal);

      const baselineExecution = await this.executeCommand(containerId, "baseline", plan.baselineCommand, plan.timeoutMs, allowedCommands, plan.networkAccess, request, environmentFingerprint);
      baseline = baselineExecution.capture;
      baselineEvidenceIds.push(...(baseline.evidenceIds ?? []));
      baselineExitCode = baseline.exitCode;
      if (baseline.status === "timed-out" || baseline.status === "cancelled" || baseline.status === "blocked" || baseline.exitCode === null) {
        failure = { code: `BASELINE_${baseline.status.toUpperCase()}`, message: "The baseline command did not complete successfully." };
      } else if (baseline.exitCode === 0) {
        classification = "not-reproduced";
      } else if (!this.options.expectedBaselineFailure || !this.options.evidenceStore) {
        failure = { code: "VERIFICATION_CAPABILITY_REQUIRED", message: "Expected baseline signature and evidence persistence are required." };
      } else if (!Number.isSafeInteger(baseline.exitCode) || baseline.exitCode < 1 || !baselineExecution.matchesExpectedFailure) {
        classification = "not-reproduced";
        failure = { code: "BASELINE_SIGNATURE_MISMATCH", message: "The baseline did not reproduce the configured failure signature." };
      } else if (baselineEvidenceIds.length === 0) {
        failure = { code: "BASELINE_EVIDENCE_REQUIRED", message: "The baseline capture could not be persisted." };
      } else {
        await this.requireDockerSuccess(["cp", patchPath, `${containerId}:/tmp/rift-candidate.patch`], plan.timeoutMs, request.signal, "Docker could not transfer the candidate patch");
        await this.execSetup(containerId, ["git", "-C", this.options.workspacePath, "apply", "--no-index", "--check", "/tmp/rift-candidate.patch"], plan.timeoutMs, request.signal);
        await this.execSetup(containerId, ["git", "-C", this.options.workspacePath, "apply", "--no-index", "/tmp/rift-candidate.patch"], plan.timeoutMs, request.signal);

        for (const command of plan.verificationCommands) {
          const { capture } = await this.executeCommand(containerId, "verification", command, plan.timeoutMs, allowedCommands, plan.networkAccess, request, environmentFingerprint);
          verification.push(capture);
          patchedEvidenceIds.push(...(capture.evidenceIds ?? []));
        }
        patchedExitCode = verification.length === 0 ? null : verification[verification.length - 1].exitCode;
        const allPassed = verification.length > 0 && verification.every((item) => item.status === "succeeded" && item.exitCode === 0 && (item.evidenceIds?.length ?? 0) > 0);
        classification = allPassed ? "verified" : "regressed";
        if (!allPassed) failure = { code: "VERIFICATION_FAILED", message: "At least one patched verification command failed." };
      }
    } catch (error) {
      failure = toFailure(error);
      classification = "inconclusive";
    } finally {
      if (containerId !== undefined) {
        try {
          // Cleanup must not inherit a cancelled request. A cancelled worker
          // still owns the obligation to remove its disposable container.
          const removed = await this.dockerCommand(["rm", "-f", containerId], undefined, 5_000);
          if (removed.exitCode !== 0 || removed.timedOut || removed.cancelled) cleanupSucceeded = false;
        } catch {
          cleanupSucceeded = false;
        }
      }
      try {
        await rm(tempDirectory, { recursive: true, force: true });
      } catch {
        cleanupSucceeded = false;
      }
    }

    if (!baseline) {
      baseline = emptyCapture("baseline", plan.baselineCommand, failure);
    }
    if (!cleanupSucceeded) {
      classification = "inconclusive";
      failure = { code: "CLEANUP_FAILED", message: "The disposable sandbox could not be fully cleaned up." };
    }
    const result = this.makeResult(plan, classification, baselineExitCode, patchedExitCode, baselineEvidenceIds, patchedEvidenceIds, failure);
    const validated = validateVerificationResult(result);
    if (!validated.ok) throw new SandboxRunnerError("Runner produced an invalid verification result", "CONTAINER");
    return { verificationResult: validated.value, baseline, verification, environmentFingerprint, cleanupSucceeded };
  }

  private validateRequest(request: SandboxRunRequest): void {
    const patch = validateCandidatePatch(request.candidatePatch);
    const plan = validateVerificationPlan(request.verificationPlan);
    if (!patch.ok || !plan.ok) throw new SandboxRunnerError("Candidate patch or verification plan failed contract validation", "INVALID_INPUT");
    const { contentHash: _contentHash, ...patchWithoutHash } = request.candidatePatch;
    if (request.candidatePatch.contentHash !== hashJson(patchWithoutHash)) {
      throw new SandboxRunnerError("Candidate patch content hash does not match its canonical content", "INVALID_INPUT");
    }
    if (request.candidatePatch.id !== request.verificationPlan.candidatePatchId) {
      throw new SandboxRunnerError("Verification plan does not select the supplied candidate patch", "INVALID_INPUT");
    }
    if (request.candidatePatch.incidentId !== request.verificationPlan.incidentId || request.candidatePatch.correlationId !== request.verificationPlan.correlationId) {
      throw new SandboxRunnerError("Candidate patch and verification plan use different incident contexts", "INVALID_INPUT");
    }
    if (
      request.candidatePatch.baseRevision.repository !== request.verificationPlan.baseRevision.repository ||
      request.candidatePatch.baseRevision.revision !== request.verificationPlan.baseRevision.revision
    ) {
      throw new SandboxRunnerError("Candidate patch and verification plan use different base revisions", "INVALID_INPUT");
    }
    if (request.verificationPlan.networkAccess === "allowlisted" && !this.options.networkName) {
      throw new SandboxRunnerError("Allowlisted network plans require an explicit Docker network", "INVALID_INPUT");
    }
    if (!isAbsolute(request.repositoryPath)) {
      throw new SandboxRunnerError("The repository path must be absolute", "HOST_REPOSITORY");
    }
  }

  private fingerprint(request: SandboxRunRequest, allowedCommands: readonly string[]): string {
    const environment = [request.verificationPlan.baselineCommand, ...request.verificationPlan.verificationCommands]
      .flatMap((command) => Object.entries(command.environment ?? {}))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, value] as const);
    return hashJson({
      image: this.options.image,
      network: request.verificationPlan.networkAccess === "disabled" ? "none" : (this.options.networkName ?? "default"),
      revision: request.verificationPlan.baseRevision,
      workspace: this.options.workspacePath,
      allowedCommands: [...allowedCommands].sort(),
      environment,
    });
  }

  private async createContainer(plan: VerificationPlan, signal?: AbortSignal): Promise<string> {
    const args = [
      "create",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--tmpfs",
      `${this.options.workspacePath}:rw,nosuid,nodev`,
      "--tmpfs",
      "/tmp:rw,nosuid,nodev",
      "--pids-limit",
      String(this.options.pidsLimit ?? 256),
    ];
    if (this.options.memoryLimit) args.push("--memory", this.options.memoryLimit);
    if (this.options.cpuLimit) args.push("--cpus", this.options.cpuLimit);
    args.push("--network", plan.networkAccess === "disabled" ? "none" : (this.options.networkName ?? "default"));
    args.push("--entrypoint", "/bin/sh", this.options.image, "-c", "while :; do sleep 3600; done");
    const output = await this.dockerCommand(args, signal);
    const id = output.stdout.toString("utf8").trim();
    if (output.exitCode !== 0 || output.timedOut || output.cancelled || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(id)) throw new SandboxRunnerError("Docker did not create a sandbox", "CONTAINER");
    return id;
  }

  private async execSetup(containerId: string, command: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const output = await this.dockerCommand(["exec", containerId, ...command], signal, timeoutMs);
    if (output.exitCode !== 0 || output.timedOut || output.cancelled) throw new SandboxRunnerError("Sandbox setup command did not complete", "PATCH");
  }

  private async requireDockerSuccess(
    args: readonly string[],
    timeoutMs: number,
    signal: AbortSignal | undefined,
    message: string,
  ): Promise<void> {
    const output = await this.dockerCommand(args, signal, timeoutMs);
    if (output.exitCode !== 0 || output.timedOut || output.cancelled) {
      throw new SandboxRunnerError(message, "CONTAINER");
    }
  }

  private async executeCommand(
    containerId: string,
    phase: SandboxCommandPhase,
    command: CommandSpec,
    timeoutMs: number,
    allowedCommands: readonly string[],
    networkAccess: VerificationPlan["networkAccess"],
    request: SandboxRunRequest,
    environmentFingerprint: string,
  ): Promise<{ capture: SandboxCommandCapture; matchesExpectedFailure: boolean }> {
    const signal = request.signal;
    const executable = basename(command.command);
    if (!allowedCommands.includes(executable) || command.command.includes("/") || /[;&|`$<>]/.test(command.command)) {
      return { capture: emptyCapture(phase, command, undefined, "blocked"), matchesExpectedFailure: false };
    }
    const workingDirectory = safeWorkingDirectory(command.workingDirectory, this.options.workspacePath);
    const args = ["exec", "-w", workingDirectory];
    if (networkAccess === "disabled") args.push("--env", "RIFT_NETWORK=disabled");
    for (const [key, value] of Object.entries(command.environment ?? {})) args.push("--env", `${key}=${value}`);
    args.push(containerId, command.command, ...(command.args ?? []));
    const startedAt = now();
    let output: ProcessResult;
    try {
      output = await this.dockerCommand(args, signal, timeoutMs);
    } catch (error) {
      return { capture: emptyCapture(phase, command, toFailure(error), signal?.aborted ? "cancelled" : "timed-out"), matchesExpectedFailure: false };
    }
    const status: SandboxCommandStatus = output.cancelled || signal?.aborted ? "cancelled" : output.timedOut ? "timed-out" : output.exitCode === 0 ? "succeeded" : "failed";
    const secrets = [...(this.options.redactValues ?? []), ...[request.verificationPlan.baselineCommand, ...request.verificationPlan.verificationCommands]
      .flatMap((item) => Object.entries(item.environment ?? {}).filter(([key]) => /secret|password|token|credential|api.?key|authorization/iu.test(key)).map(([, value]) => value))].filter(Boolean);
    const streamLimit = Math.floor((this.options.captureLimitBytes ?? 65_536) / 4);
    const stdout = cleanOutput(output.stdout, streamLimit, secrets, output.stdoutTruncated);
    const stderr = cleanOutput(output.stderr, streamLimit, secrets, output.stderrTruncated);
    const capture: SandboxCommandCapture = {
      phase,
      command: redactCommandEnvironment(command),
      status,
      exitCode: status === "timed-out" || status === "cancelled" ? null : output.exitCode,
      stdoutHash: hashBytes(Buffer.from(stdout.text)),
      stderrHash: hashBytes(Buffer.from(stderr.text)),
      stdoutBytes: output.stdoutBytes ?? output.stdout.byteLength,
      stderrBytes: output.stderrBytes ?? output.stderr.byteLength,
      stdoutTruncated: Boolean(output.stdoutTruncated || output.stdout.length > streamLimit),
      stderrTruncated: Boolean(output.stderrTruncated || output.stderr.length > streamLimit),
      startedAt,
      finishedAt: now(),
    };
    const expected = this.options.expectedBaselineFailure;
    const matchesExpectedFailure = Boolean(expected && ((expected.stream !== "stderr" && stdout.text.includes(expected.signature)) ||
      (expected.stream !== "stdout" && stderr.text.includes(expected.signature))));
    const store = this.options.evidenceStore;
    if (!store) return { capture, matchesExpectedFailure };
    const id = `evidence-${randomUUID()}`;
    const withoutHash: Omit<EvidenceItem, "contentHash"> = {
      kind: "EvidenceItem", schemaVersion: 1, id,
      incidentId: request.verificationPlan.incidentId, correlationId: request.verificationPlan.correlationId,
      createdAt: capture.finishedAt, capturedAt: capture.finishedAt,
      content: {
        phase, status, exitCode: capture.exitCode, encoding: "base64", textEncoding: "utf8",
        stdout: Buffer.from(stdout.text).toString("base64"), stderr: Buffer.from(stderr.text).toString("base64"),
        stdoutHash: capture.stdoutHash, stderrHash: capture.stderrHash,
        stdoutBytes: capture.stdoutBytes, stderrBytes: capture.stderrBytes,
        stdoutTruncated: capture.stdoutTruncated ?? false, stderrTruncated: capture.stderrTruncated ?? false,
        startedAt, finishedAt: capture.finishedAt, commandHash: hashJson(command),
        ...(phase === "baseline" && expected && status === "failed" && capture.exitCode !== null && capture.exitCode > 0 && matchesExpectedFailure ? { failureCode: expected.code } : {}),
      },
      source: { type: "verification-docker-capture", locator: `docker://${containerId}/${phase}/${id}` },
      redaction: { status: stdout.redacted || stderr.redacted ? "redacted" : "not-required", rules: [...new Set([...stdout.rules, ...stderr.rules])].sort() },
      provenance: { actor: "docker-sandbox-runner", tool: "docker", metadata: {
        verificationPlanId: request.verificationPlan.id, candidatePatchId: request.candidatePatch.id,
        image: this.options.image, revision: request.verificationPlan.baseRevision.revision,
        repository: request.verificationPlan.baseRevision.repository, phase, environmentFingerprint,
      } },
    };
    const item = { ...withoutHash, contentHash: computeEvidenceHash(withoutHash) };
    if (!validateEvidenceItem(item).ok) throw new SandboxRunnerError("Capture evidence failed validation", "CONTAINER");
    const stored = store.append(item);
    if (canonicalJson(stored as unknown as JsonValue) !== canonicalJson(item as unknown as JsonValue) ||
      canonicalJson((store.get(id) ?? null) as unknown as JsonValue) !== canonicalJson(item as unknown as JsonValue)) {
      throw new SandboxRunnerError("Capture evidence persistence could not be confirmed", "CONTAINER");
    }
    return { capture: { ...capture, evidenceIds: [stored.id] }, matchesExpectedFailure };
  }

  private async dockerCommand(args: readonly string[], signal?: AbortSignal, timeoutMs?: number): Promise<ProcessResult> {
    return this.docker.run(this.options.dockerExecutable, args, { signal, timeoutMs });
  }

  private makeResult(
    plan: VerificationPlan,
    classification: VerificationResult["classification"],
    baselineExitCode: number | null,
    patchedExitCode: number | null,
    baselineEvidenceIds: readonly string[],
    patchedEvidenceIds: readonly string[],
    failure?: { code: string; message: string },
  ): VerificationResult {
    const withoutHash = {
      kind: "VerificationResult" as const,
      schemaVersion: 1 as const,
      id: `${plan.id}-result`,
      incidentId: plan.incidentId,
      correlationId: plan.correlationId,
      createdAt: now(),
      verificationPlanId: plan.id,
      classification,
      baselineExitCode,
      patchedExitCode,
      evidenceIds: [...baselineEvidenceIds, ...patchedEvidenceIds],
      baselineEvidenceIds: [...baselineEvidenceIds],
      patchedEvidenceIds: [...patchedEvidenceIds],
      ...(failure ? { failure } : {}),
    };
    return { ...withoutHash, contentHash: hashJson(withoutHash) };
  }
}

export class SpawnProcessRunner implements ProcessRunner {
  public constructor(private readonly captureLimitBytes = 131_072) {
    if (!Number.isSafeInteger(captureLimitBytes) || captureLimitBytes < 1 || captureLimitBytes > 268_435_456) throw new SandboxRunnerError("Invalid process capture limit", "INVALID_INPUT");
  }
  public run(command: string, args: readonly string[], options: ProcessRunOptions = {}): Promise<ProcessResult> {
    if (options.signal?.aborted) return Promise.resolve({ exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), cancelled: true });
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, [...args], { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0, stderrBytes = 0;
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      const finish = (result: ProcessResult): void => {
        if (settled) return;
        settled = true;
        resolvePromise(result);
      };
      child.stdout.on("data", (chunk: Buffer) => { const retained = chunk.subarray(0, Math.max(0, this.captureLimitBytes - stdoutBytes)); if (retained.length) stdout.push(Buffer.from(retained)); stdoutBytes += chunk.length; });
      child.stderr.on("data", (chunk: Buffer) => { const retained = chunk.subarray(0, Math.max(0, this.captureLimitBytes - stderrBytes)); if (retained.length) stderr.push(Buffer.from(retained)); stderrBytes += chunk.length; });
      const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs) : undefined;
      const abort = (): void => { cancelled = true; child.kill("SIGKILL"); };
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
      child.on("error", (error) => { if (timer) clearTimeout(timer); options.signal?.removeEventListener("abort", abort); if (!settled) { settled = true; reject(error); } });
      child.on("close", (exitCode) => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        finish({ exitCode: timedOut || cancelled ? null : exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), timedOut, cancelled,
          stdoutBytes, stderrBytes, stdoutTruncated: stdoutBytes > this.captureLimitBytes, stderrTruncated: stderrBytes > this.captureLimitBytes });
      });
    });
  }
}

function safeWorkingDirectory(value: string | undefined, workspace: string): string {
  if (!value) return workspace;
  if (posix.isAbsolute(value) || value.split(/[\\/]/u).some((part) => part === ".." || part === "")) {
    throw new SandboxRunnerError("Command working directory must be a relative path inside the workspace", "INVALID_INPUT");
  }
  return posix.join(workspace, value);
}

function emptyCapture(
  phase: SandboxCommandPhase,
  command: CommandSpec,
  failure?: { code: string; message: string },
  status: SandboxCommandStatus = "failed",
): SandboxCommandCapture {
  const timestamp = now();
  return { phase, command: redactCommandEnvironment(command), status, exitCode: null, stdoutHash: EMPTY_HASH, stderrHash: EMPTY_HASH, stdoutBytes: 0, stderrBytes: 0, startedAt: timestamp, finishedAt: timestamp };
}

function redactCommandEnvironment(command: CommandSpec): CommandSpec {
  if (command.environment === undefined) return command;
  return { ...command, environment: Object.fromEntries(Object.keys(command.environment).sort().map((key) => [key, "[REDACTED]"])) };
}

function toFailure(error: unknown): { code: string; message: string } {
  if (error instanceof SandboxRunnerError) return { code: error.code, message: error.message };
  return { code: "CONTAINER_ERROR", message: "Sandbox execution or evidence persistence failed." };
}

function now(): string {
  return new Date().toISOString();
}

function hashBytes(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hashJson(value: JsonValue | object): string {
  return hashBytes(Buffer.from(canonicalJson(value as JsonValue), "utf8"));
}

function cleanOutput(buffer: Buffer, limit: number, secrets: readonly string[], transportTruncated = false): { text: string; redacted: boolean; rules: readonly string[] } {
  let text = buffer.subarray(0, limit).toString("utf8");
  let literalRedacted = false;
  for (const secret of secrets) {
    if (text.includes(secret)) { text = text.split(secret).join("[REDACTED]"); literalRedacted = true; }
    if (buffer.length > limit || transportTruncated) for (let length = Math.min(secret.length - 1, text.length); length > 0; length--) {
      if (text.endsWith(secret.slice(0, length))) { text = `${text.slice(0, -length)}[REDACTED]`; literalRedacted = true; break; }
    }
  }
  if (/-----BEGIN [^-]*PRIVATE KEY-----/u.test(text) && !/-----END [^-]*PRIVATE KEY-----/u.test(text)) {
    text = text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*/u, "[REDACTED]"); literalRedacted = true;
  }
  const redacted = redactSecrets(text);
  let bounded = Buffer.from(redacted.value as string).subarray(0, limit).toString("utf8");
  // Decoding a cut UTF-8 sequence can add a three-byte replacement character.
  while (Buffer.byteLength(bounded) > limit) bounded = bounded.slice(0, -1);
  return { text: bounded, redacted: literalRedacted || redacted.redacted,
    rules: [...redacted.rules, ...(literalRedacted ? ["configured-value-or-partial-key"] : [])] };
}
