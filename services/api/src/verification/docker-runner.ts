import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, posix, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { CandidatePatch, CommandSpec, JsonValue, VerificationPlan, VerificationResult } from "@rift/core";
import { validateCandidatePatch, validateVerificationPlan, validateVerificationResult } from "@rift/core";
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
    this.options = {
      ...options,
      image: options.image,
      dockerExecutable: options.dockerExecutable ?? "docker",
      workspacePath: options.workspacePath ?? "/workspace",
    };
    this.docker = options.docker ?? new SpawnProcessRunner();
    this.host = options.host ?? new SpawnProcessRunner();
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
    let failure: { code: string; message: string } | undefined;
    let classification: VerificationResult["classification"] = "inconclusive";
    let baselineExitCode: number | null = null;
    let patchedExitCode: number | null = null;

    try {
      const archivePath = join(tempDirectory, "source.tar");
      const patchPath = join(tempDirectory, "candidate.patch");
      const archive = await this.host.run("git", ["-C", resolve(request.repositoryPath), "archive", "--format=tar", plan.baseRevision.revision], {
        timeoutMs: plan.timeoutMs,
        signal: request.signal,
      });
      if (archive.exitCode !== 0 || archive.stdout.byteLength === 0) {
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

      baseline = await this.executeCommand(containerId, "baseline", plan.baselineCommand, plan.timeoutMs, allowedCommands, plan.networkAccess, request.signal);
      baselineExitCode = baseline.exitCode;
      if (baseline.status === "timed-out" || baseline.status === "cancelled" || baseline.status === "blocked" || baseline.exitCode === null) {
        failure = { code: `BASELINE_${baseline.status.toUpperCase()}`, message: "The baseline command did not complete successfully." };
      } else if (baseline.exitCode === 0) {
        classification = "not-reproduced";
      } else {
        await this.dockerCommand(["cp", patchPath, `${containerId}:/tmp/rift-candidate.patch`], request.signal);
        await this.execSetup(containerId, ["git", "-C", this.options.workspacePath, "apply", "--no-index", "--check", "/tmp/rift-candidate.patch"], plan.timeoutMs, request.signal);
        await this.execSetup(containerId, ["git", "-C", this.options.workspacePath, "apply", "--no-index", "/tmp/rift-candidate.patch"], plan.timeoutMs, request.signal);

        for (const command of plan.verificationCommands) {
          const capture = await this.executeCommand(containerId, "verification", command, plan.timeoutMs, allowedCommands, plan.networkAccess, request.signal);
          verification.push(capture);
        }
        patchedExitCode = verification.length === 0 ? null : verification[verification.length - 1].exitCode;
        const allPassed = verification.length > 0 && verification.every((item) => item.status === "succeeded" && item.exitCode === 0);
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
           const removed = await this.dockerCommand(["rm", "-f", containerId]);
          if (removed.exitCode !== 0) cleanupSucceeded = false;
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
    const result = this.makeResult(plan, classification, baselineExitCode, patchedExitCode, failure);
    const validated = validateVerificationResult(result);
    if (!validated.ok) throw new SandboxRunnerError("Runner produced an invalid verification result", "CONTAINER");
    return { verificationResult: validated.value, baseline, verification, environmentFingerprint, cleanupSucceeded };
  }

  private validateRequest(request: SandboxRunRequest): void {
    const patch = validateCandidatePatch(request.candidatePatch);
    const plan = validateVerificationPlan(request.verificationPlan);
    if (!patch.ok || !plan.ok) throw new SandboxRunnerError("Candidate patch or verification plan failed contract validation", "INVALID_INPUT");
    if (request.candidatePatch.id !== request.verificationPlan.candidatePatchId) {
      throw new SandboxRunnerError("Verification plan does not select the supplied candidate patch", "INVALID_INPUT");
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
    if (output.exitCode !== 0 || id === "") throw new SandboxRunnerError("Docker did not create a sandbox", "CONTAINER");
    return id;
  }

  private async execSetup(containerId: string, command: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const output = await this.dockerCommand(["exec", containerId, ...command], signal, timeoutMs);
    if (output.exitCode !== 0) throw new SandboxRunnerError(`Sandbox setup command failed: ${command.join(" ")}`, "PATCH");
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
    signal?: AbortSignal,
  ): Promise<SandboxCommandCapture> {
    const executable = basename(command.command);
    if (!allowedCommands.includes(executable) || command.command.includes("/") || /[;&|`$<>]/.test(command.command)) {
      return emptyCapture(phase, command, { code: "COMMAND_BLOCKED", message: `Command is not in the sandbox allowlist: ${command.command}` }, "blocked");
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
      return emptyCapture(phase, command, toFailure(error), signal?.aborted ? "cancelled" : "timed-out");
    }
    const status: SandboxCommandStatus = output.cancelled || signal?.aborted ? "cancelled" : output.timedOut ? "timed-out" : output.exitCode === 0 ? "succeeded" : "failed";
    return {
      phase,
      command,
      status,
      exitCode: output.exitCode,
      stdoutHash: hashBytes(output.stdout),
      stderrHash: hashBytes(output.stderr),
      stdoutBytes: output.stdout.byteLength,
      stderrBytes: output.stderr.byteLength,
      startedAt,
      finishedAt: now(),
    };
  }

  private async dockerCommand(args: readonly string[], signal?: AbortSignal, timeoutMs?: number): Promise<ProcessResult> {
    return this.docker.run(this.options.dockerExecutable, args, { signal, timeoutMs });
  }

  private makeResult(
    plan: VerificationPlan,
    classification: VerificationResult["classification"],
    baselineExitCode: number | null,
    patchedExitCode: number | null,
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
      evidenceIds: [],
      ...(failure ? { failure } : {}),
    };
    return { ...withoutHash, contentHash: hashJson(withoutHash) };
  }
}

export class SpawnProcessRunner implements ProcessRunner {
  public run(command: string, args: readonly string[], options: ProcessRunOptions = {}): Promise<ProcessResult> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, [...args], { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      let settled = false;
      const finish = (result: ProcessResult): void => {
        if (settled) return;
        settled = true;
        resolvePromise(result);
      };
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs) : undefined;
      const abort = (): void => { child.kill("SIGKILL"); finish({ exitCode: null, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), cancelled: true }); };
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
      child.on("error", (error) => { if (timer) clearTimeout(timer); if (!settled) reject(error); });
      child.on("close", (exitCode) => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        finish({ exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), timedOut });
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
  return { phase, command, status, exitCode: null, stdoutHash: EMPTY_HASH, stderrHash: EMPTY_HASH, stdoutBytes: 0, stderrBytes: 0, startedAt: timestamp, finishedAt: timestamp };
}

function toFailure(error: unknown): { code: string; message: string } {
  if (error instanceof SandboxRunnerError) return { code: error.code, message: error.message };
  return { code: "CONTAINER_ERROR", message: error instanceof Error ? error.message : "Unknown sandbox failure" };
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

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
