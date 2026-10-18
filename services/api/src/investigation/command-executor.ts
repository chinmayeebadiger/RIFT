import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve, relative, isAbsolute, sep } from "node:path";
import type { CommandExecution, CommandSpec, JsonValue } from "@rift/core";
import { sha256 } from "../domain/hashing.js";
import { redactSecrets } from "../domain/redaction.js";
import type {
  CommandExecutionRequest,
  CommandExecutor as CommandExecutorPort,
} from "./ports.js";
import type { SnapshotWorkspaceProvider } from "./repository-snapshot.js";

const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_OUTPUT_BYTES = 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const DANGEROUS_ENVIRONMENT_KEY = /^(?:PATH|NODE_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH)$/u;

export type ProcessExit = {
  readonly exitCode: number | null;
  readonly signal?: string | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly resourceLimitExceeded?: boolean;
  readonly processLimitExceeded?: boolean;
};

export interface ProcessLaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly networkAccess: "disabled" | "allowlisted";
  readonly allowedNetworkHosts: readonly string[];
  readonly resourceLimits: ResourceLimits;
}

export interface ProcessHandle {
  readonly completion: Promise<ProcessExit>;
  kill(): Promise<void> | void;
  cleanup(): Promise<void> | void;
}

/** The executor depends on this small boundary, making security tests offline. */
export interface ProcessAdapter {
  start(spec: ProcessLaunchSpec): Promise<ProcessHandle> | ProcessHandle;
}

export interface FilesystemAdapter {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<{ readonly isSymbolicLink: () => boolean }>;
}

export interface ResourceLimits {
  readonly maxOutputBytes: number;
  readonly maxProcesses: number;
  readonly maxMemoryBytes?: number;
  readonly maxCpuMs?: number;
}

export interface CommandExecutorOptions {
  readonly workspaceRoot?: string;
  readonly processAdapter?: ProcessAdapter;
  readonly containerImage?: string;
  readonly filesystemAdapter?: FilesystemAdapter;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly allowlistedNetworkHosts?: readonly string[];
  readonly resourceLimits?: Partial<ResourceLimits>;
}

type FailureCode =
  | "POLICY_INVALID"
  | "COMMAND_NOT_ALLOWLISTED"
  | "NETWORK_POLICY_DENIED"
  | "FILESYSTEM_BOUNDARY"
  | "SYMLINK_NOT_ALLOWED"
  | "ARGUMENT_PATH_ESCAPE"
  | "TIMEOUT_INVALID"
  | "PROCESS_LIMIT_EXCEEDED"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "COMMAND_FAILED"
  | "EXECUTION_ERROR"
  | "CANCELLED"
  | "TIMED_OUT"
  | "CLEANUP_FAILED";

interface SafeCommand {
  readonly command: string;
  readonly args?: readonly string[];
  readonly workingDirectory?: string;
  readonly environment?: Readonly<Record<string, string>>;
}

const defaultFilesystem: FilesystemAdapter = {
  realpath,
  lstat,
};

function defaultId(): string {
  return `command-execution-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`.slice(0, 128);
}

function safeId(value: unknown, fallback: string): string {
  const candidate = typeof value === "string" ? value : fallback;
  const cleaned = candidate.replace(/[^A-Za-z0-9_-]/gu, "-").slice(0, 128);
  return ID_PATTERN.test(cleaned) ? cleaned : fallback;
}

function redact(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) {
    if (secret.length > 0) result = result.split(secret).join("[REDACTED]");
  }
  // Apply the shared evidence rules too: credentials printed by a command need
  // not have originated in its explicit environment or argument list.
  result = redactSecrets(result).value as string;
  return result.replace(/((?:password|passwd|secret|token|api[_-]?key|authorization)\s*[=:]\s*)[^\s,;]+/giu, "$1[REDACTED]");
}

function redactCommandArguments(args: readonly string[], secrets: readonly string[]): string[] {
  const redacted: string[] = [];
  let redactNext = false;
  for (const argument of args) {
    const sensitiveFlag = /^(?:--?)(?:password|passwd|secret|token|api[_-]?key|authorization)(?:=|$)/iu.test(argument);
    const value = redact(argument, secrets);
    if (redactNext) {
      redacted.push("[REDACTED]");
      redactNext = false;
    } else if (sensitiveFlag && !argument.includes("=")) {
      redacted.push(argument);
      redactNext = true;
    } else if (sensitiveFlag && argument.includes("=")) {
      redacted.push(`${argument.slice(0, argument.indexOf("=") + 1)}[REDACTED]`);
    } else {
      redacted.push(value);
    }
  }
  return redacted;
}

function secretValues(command: Partial<CommandSpec> | undefined): string[] {
  if (!command) return [];
  const values = Object.entries(command.environment ?? {})
    .filter(([key, value]) => typeof value === "string" && (/password|passwd|secret|token|key|auth/iu.test(key) || value.length >= 24))
    .map(([, value]) => value)
    .filter((value) => value.length > 0);
  let sensitiveValue = false;
  for (const argument of Array.isArray(command.args) ? command.args : []) {
    if (typeof argument !== "string") continue;
    if (sensitiveValue && argument.length > 0) values.push(argument);
    sensitiveValue = /^(?:--?)(?:password|passwd|secret|token|api[_-]?key|authorization)$/iu.test(argument);
    const inline = /^(?:--?)?(?:password|passwd|secret|token|api[_-]?key|authorization)=(.+)$/iu.exec(argument);
    if (inline?.[1]) values.push(inline[1]);
  }
  return [...new Set(values)].sort((left, right) => right.length - left.length);
}

function safeCommand(command: CommandSpec | undefined): SafeCommand {
  const secrets = secretValues(command);
  const safe: { command: string; args?: readonly string[]; workingDirectory?: string; environment?: Record<string, string> } = {
    command: redact(typeof command?.command === "string" ? command.command : "[INVALID]", secrets),
  };
  if (Array.isArray(command?.args)) safe.args = redactCommandArguments(command.args.filter((argument): argument is string => typeof argument === "string"), secrets);
  if (typeof command?.workingDirectory === "string") safe.workingDirectory = redact(command.workingDirectory, secrets);
  // Environment values are never returned. This also prevents a valid result from
  // becoming a credential exfiltration channel when the input is untrusted.
  return safe;
}

function failureMessage(code: FailureCode): string {
  const messages: Record<FailureCode, string> = {
    POLICY_INVALID: "Execution policy rejected the request.",
    COMMAND_NOT_ALLOWLISTED: "The command is not allowlisted.",
    NETWORK_POLICY_DENIED: "The requested network policy is not permitted.",
    FILESYSTEM_BOUNDARY: "The working directory is outside the execution workspace.",
    SYMLINK_NOT_ALLOWED: "Symlink traversal is not permitted.",
    ARGUMENT_PATH_ESCAPE: "A command argument crosses the execution boundary.",
    TIMEOUT_INVALID: "The execution timeout is invalid.",
    PROCESS_LIMIT_EXCEEDED: "The process resource limit was exceeded.",
    OUTPUT_LIMIT_EXCEEDED: "The output resource limit was exceeded.",
    COMMAND_FAILED: "The command exited unsuccessfully.",
    EXECUTION_ERROR: "The command could not be executed.",
    CANCELLED: "Execution was cancelled.",
    TIMED_OUT: "Execution timed out.",
    CLEANUP_FAILED: "Execution cleanup failed.",
  };
  return messages[code];
}

function isPathEscape(value: string): boolean {
  const pathValue = value.startsWith("-") && value.includes("=") ? value.slice(value.indexOf("=") + 1) : value;
  if (isAbsolute(pathValue) || /^[A-Za-z]:[/\\]/u.test(pathValue) || pathValue.startsWith("\\") || pathValue.startsWith("~") || CONTROL_PATTERN.test(value)) return true;
  const parts = value.replaceAll("\\", "/").split("/");
  return parts.includes("..") || /(?:^|[=:])\.\.(?:[/\\]|$)/u.test(value) || value.includes("\0");
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function spawnProcessAdapter(spawnCommand: string | undefined, spawnArgs: (spec: ProcessLaunchSpec) => readonly string[], cwd: (spec: ProcessLaunchSpec) => string | undefined, removeContainer?: () => Promise<void>, environmentInput = false): ProcessAdapter {
  return {
    start(spec) {
      const child: ChildProcess = spawn(spawnCommand ?? spec.command, [...spawnArgs(spec)], {
        cwd: cwd(spec),
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", ...(environmentInput ? {} : spec.environment) },
        shell: false,
        detached: process.platform !== "win32",
        stdio: [environmentInput ? "pipe" : "ignore", "pipe", "pipe"],
      });
      // Docker reads the container environment from stdin. It must never be
      // interpreted as configuration of the host Docker client (e.g. HOME or
      // DOCKER_HOST), written to disk, or exposed in process-list arguments.
      if (environmentInput) {
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(Object.entries(spec.environment).map(([key, value]) => `${key}=${value}\n`).join(""));
      }
      let outputBytes = 0;
      let resourceLimitExceeded = false;
      const chunks: Buffer[] = [];
      const errorChunks: Buffer[] = [];
      const append = (target: Buffer[], chunk: Buffer): void => {
        outputBytes += chunk.byteLength;
        if (outputBytes > spec.resourceLimits.maxOutputBytes) {
          resourceLimitExceeded = true;
          void kill().catch(() => undefined);
          return;
        }
        target.push(chunk);
      };
      child.stdout?.on("data", (chunk: Buffer) => append(chunks, chunk));
      child.stderr?.on("data", (chunk: Buffer) => append(errorChunks, chunk));
      let termination: Promise<void> | undefined;
      const kill = (): Promise<void> => {
        termination ??= (async () => {
          try {
            // Killing the Docker CLI alone leaves its container running.
            await removeContainer?.();
          } finally {
            try {
              if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
              else if (child.exitCode === null) child.kill("SIGKILL");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            }
          }
        })();
        return termination;
      };
      const abort = (): void => { void kill().catch(() => undefined); };
      spec.signal.addEventListener("abort", abort, { once: true });
      if (spec.signal.aborted) abort();
      const completion = new Promise<ProcessExit>((resolveCompletion, reject) => {
        child.once("error", reject);
        child.once("close", (exitCode, signal) => {
          spec.signal.removeEventListener("abort", abort);
          resolveCompletion({
            exitCode,
            signal,
            stdout: Buffer.concat(chunks).toString("utf8"),
            stderr: Buffer.concat(errorChunks).toString("utf8"),
            resourceLimitExceeded,
          });
        });
      });
      return {
        completion,
        kill,
        cleanup: async () => {
          spec.signal.removeEventListener("abort", abort);
          let failed = false;
          try { await kill(); } catch { failed = true; }
          await completion.catch(() => undefined);
          // Also cover cancellation while the Docker daemon was still creating
          // the named container when the first removal was requested.
          try { await removeContainer?.(); } catch { failed = true; }
          if (failed) throw new Error("process cleanup failed");
        },
      };
    },
  };
}

function localProcessAdapter(): ProcessAdapter {
  return spawnProcessAdapter(undefined, (spec) => spec.args, (spec) => spec.cwd);
}

/**
 * Docker is the production adapter. The host-process adapter remains exported
 * for deterministic unit tests only; it must never be used for untrusted runs.
 */
export function DockerProcessAdapter(image = "node:20.11.1-bookworm-slim"): ProcessAdapter {
  return {
    start(spec) {
      const name = `rift-command-${randomUUID()}`;
      return spawnProcessAdapter("docker", (spec) => {
        if (spec.networkAccess === "allowlisted") {
          throw new Error("allowlisted network requires a configured egress proxy");
        }
        const args = [
          "run", "--name", name, "--init", "--network=none", "--read-only",
          "--cap-drop=ALL", "--security-opt=no-new-privileges",
          // The init process occupies one PID in addition to the command budget.
          `--pids-limit=${spec.resourceLimits.maxProcesses + 1}`,
          "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
          "--mount", `type=bind,src=${spec.cwd},dst=/workspace,readonly`,
          "--workdir", "/workspace",
        ];
        if (spec.resourceLimits.maxMemoryBytes !== undefined) args.push(`--memory=${spec.resourceLimits.maxMemoryBytes}`);
        if (spec.resourceLimits.maxCpuMs !== undefined) args.push(`--cpus=${Math.max(spec.resourceLimits.maxCpuMs / 1000, 0.001)}`);
        if (Object.keys(spec.environment).length > 0) args.push("--env-file", "/dev/stdin");
        return [...args, image, spec.command, ...spec.args];
      }, () => undefined, () => removeDockerContainer(name), true).start(spec);
    },
  };
}

function removeDockerContainer(name: string): Promise<void> {
  return new Promise((resolveRemoval, reject) => {
    const child = spawn("docker", ["rm", "--force", name], {
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" }, shell: false, stdio: ["ignore", "ignore", "pipe"],
    });
    let missing = "";
    child.stderr.on("data", (chunk: Buffer) => { missing = (missing + chunk.toString("utf8")).slice(-4096); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("container cleanup timed out")); }, 5_000);
    child.once("error", () => { clearTimeout(timer); reject(new Error("container cleanup failed")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || /No such container:/u.test(missing)) resolveRemoval();
      else reject(new Error("container cleanup failed"));
    });
  });
}

export class CommandExecutor implements CommandExecutorPort {
  private readonly outputs = new Map<string, CommandOutput>();
  private readonly root: string;
  private readonly processes: ProcessAdapter;
  private readonly filesystem: FilesystemAdapter;
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly networkHosts: readonly string[];
  private readonly limits: ResourceLimits;

  public constructor(options: CommandExecutorOptions = {}) {
    // A production Docker run must receive a disposable snapshot directory.
    // Only injected test adapters may use the current process directory.
    this.root = options.workspaceRoot ?? (options.processAdapter ? process.cwd() : "");
    this.processes = options.processAdapter ?? DockerProcessAdapter(options.containerImage);
    this.filesystem = options.filesystemAdapter ?? defaultFilesystem;
    this.clock = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? defaultId;
    this.networkHosts = options.allowlistedNetworkHosts ?? [];
    this.limits = {
      maxOutputBytes: options.resourceLimits?.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES,
      maxProcesses: options.resourceLimits?.maxProcesses ?? 1,
      maxMemoryBytes: options.resourceLimits?.maxMemoryBytes,
      maxCpuMs: options.resourceLimits?.maxCpuMs,
    };
  }

  public async execute(request: CommandExecutionRequest): Promise<CommandExecution> {
    const startedAt = this.clock().toISOString();
    const command = safeCommand(request.command);
    let status: CommandExecution["status"] = "blocked";
    let exitCode: number | null = null;
    let code: FailureCode | undefined;
    let handle: ProcessHandle | undefined;
    let timedOut = false;
    let cleanupFailed = false;
    let captured: ProcessExit | undefined;
    let outputLimit = this.limits.maxOutputBytes;
    let termination: Promise<void> | undefined;
    const controller = new AbortController();
    const requestSignal = request.signal;
    const abortRequest = (): void => controller.abort();
    const abortProcess = (): void => {
      if (handle) termination ??= Promise.resolve().then(() => handle!.kill()).catch(() => { cleanupFailed = true; });
    };
    controller.signal.addEventListener("abort", abortProcess);
    if (requestSignal?.aborted) controller.abort();
    else requestSignal?.addEventListener("abort", abortRequest, { once: true });

    try {
      code = await this.policyFailure(request);
      if (code) {
        status = "blocked";
      } else if (controller.signal.aborted) {
        status = "cancelled";
        code = "CANCELLED";
      } else {
        const cwd = await this.resolveWorkingDirectory(request.command.workingDirectory);
        const capability = request.capability;
        const limits = { ...this.limits, ...capability.resourceLimits };
        outputLimit = limits.maxOutputBytes;
        const networkHosts = capability.allowedNetworkHosts ?? this.networkHosts;
        if (!this.validResourceLimits(limits)) {
          code = "PROCESS_LIMIT_EXCEEDED";
        } else {
          if (controller.signal.aborted) throw new Error("cancelled");
          handle = await this.processes.start({
            command: request.command.command,
            args: [...(request.command.args ?? [])],
            cwd,
            environment: request.command.environment ?? {},
            signal: controller.signal,
            networkAccess: request.capability.networkAccess,
            allowedNetworkHosts: networkHosts,
            resourceLimits: limits,
          });
          if (controller.signal.aborted) abortProcess();
          const timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, request.capability.timeoutMs);
          try {
            const completion = handle.completion.then((result) => { captured = result; return result; });
            let stopWaiting!: () => void;
            const stopped = new Promise<ProcessExit>((resolveStopped) => {
              stopWaiting = () => resolveStopped({ exitCode: null });
              controller.signal.addEventListener("abort", stopWaiting, { once: true });
              if (controller.signal.aborted) stopWaiting();
            });
            const result = await Promise.race([completion, stopped]).finally(() => controller.signal.removeEventListener("abort", stopWaiting));
            exitCode = result.exitCode;
            if (timedOut) {
              status = "timed-out";
              code = "TIMED_OUT";
            } else if (requestSignal?.aborted || controller.signal.aborted) {
              status = "cancelled";
              code = "CANCELLED";
            } else if (result.processLimitExceeded) {
              status = "failed";
              code = "PROCESS_LIMIT_EXCEEDED";
            } else if (result.resourceLimitExceeded) {
              status = "failed";
              code = "OUTPUT_LIMIT_EXCEEDED";
            } else if (result.exitCode === 0) {
              status = "succeeded";
            } else {
              status = "failed";
              code = "COMMAND_FAILED";
            }
          } catch {
            status = timedOut ? "timed-out" : requestSignal?.aborted ? "cancelled" : "failed";
            code = timedOut ? "TIMED_OUT" : requestSignal?.aborted ? "CANCELLED" : "EXECUTION_ERROR";
          } finally {
            clearTimeout(timeout);
          }
        }
      }
    } catch (error) {
      // Do not put adapter errors, command lines, or process output across the
      // trust boundary: their contents can contain credentials or host paths.
      if (timedOut) {
        status = "timed-out";
        code = "TIMED_OUT";
      } else if (requestSignal?.aborted || controller.signal.aborted) {
        status = "cancelled";
        code = "CANCELLED";
      } else if (error instanceof Error && error.message === "symlink") {
        status = "blocked";
        code = "SYMLINK_NOT_ALLOWED";
      } else if (error instanceof Error && error.message === "filesystem boundary") {
        status = "blocked";
        code = "FILESYSTEM_BOUNDARY";
      } else {
        status = "failed";
        code = "EXECUTION_ERROR";
      }
    } finally {
      requestSignal?.removeEventListener("abort", abortRequest);
      controller.signal.removeEventListener("abort", abortProcess);
      if (handle) {
        try {
          await termination;
          await handle.cleanup();
        } catch {
          cleanupFailed = true;
        }
      }
    }

    if (cleanupFailed) {
      status = "failed";
      code = "CLEANUP_FAILED";
    }
    const finishedDate = this.clock();
    const finishedAt = finishedDate.toISOString() < startedAt ? startedAt : finishedDate.toISOString();
    const body = {
      kind: "CommandExecution" as const,
      schemaVersion: 1 as const,
      id: safeId(this.idFactory(), "command-execution"),
      incidentId: safeId(request.incidentId, "incident"),
      correlationId: safeId(request.correlationId, "correlation"),
      createdAt: startedAt,
      snapshotId: safeId(request.snapshotId, "snapshot"),
      command,
      status,
      exitCode,
      startedAt,
      finishedAt,
      evidenceIds: [],
      ...(code ? { failure: { code, message: failureMessage(code) } } : {}),
    };
    const execution = { ...body, contentHash: sha256(body as unknown as JsonValue) } satisfies CommandExecution;
    const secrets = secretValues(request.command);
    const boundedText = (value: string, limit: number): string => {
      const bytes = Buffer.from(redact(value, secrets));
      if (bytes.byteLength <= limit) return bytes.toString("utf8");
      // A partial UTF-8 character must not expand into a replacement character
      // whose encoded size would exceed the byte budget.
      return bytes.subarray(0, limit).toString("utf8").replace(/\uFFFD$/u, "");
    };
    const stdout = boundedText(captured?.stdout ?? "", outputLimit);
    const stderr = boundedText(captured?.stderr ?? "", Math.max(0, outputLimit - Buffer.byteLength(stdout)));
    this.outputs.set(execution.id, { stdout, stderr });
    return execution;
  }

  public getOutput(executionId: string): CommandOutput | undefined {
    return this.outputs.get(executionId);
  }

  private async policyFailure(request: CommandExecutionRequest): Promise<FailureCode | undefined> {
    if (!request || typeof request !== "object") return "POLICY_INVALID";
    const { capability, command } = request;
    if (!capability || typeof capability !== "object" || !command || typeof command !== "object") return "POLICY_INVALID";
    if (typeof command.command !== "string" || command.command.length === 0 || CONTROL_PATTERN.test(command.command)) return "POLICY_INVALID";
    if (command.args !== undefined && (!Array.isArray(command.args) || command.args.some((argument) => typeof argument !== "string"))) return "POLICY_INVALID";
    if (command.workingDirectory !== undefined && typeof command.workingDirectory !== "string") return "POLICY_INVALID";
    if (command.environment !== undefined && (typeof command.environment !== "object" || command.environment === null || Array.isArray(command.environment))) return "POLICY_INVALID";
    if (!Number.isSafeInteger(capability.timeoutMs) || capability.timeoutMs < 1 || capability.timeoutMs > MAX_TIMEOUT_MS) return "TIMEOUT_INVALID";
    if (!Array.isArray(capability.allowedCommands) || capability.allowedCommands.length === 0 || capability.allowedCommands.some((allowed) => typeof allowed !== "string" || allowed.length === 0 || CONTROL_PATTERN.test(allowed))) return "POLICY_INVALID";
    if (CONTROL_PATTERN.test(command.command) || !capability.allowedCommands.includes(command.command)) return "COMMAND_NOT_ALLOWLISTED";
    if (capability.networkAccess !== "disabled" && capability.networkAccess !== "allowlisted") return "NETWORK_POLICY_DENIED";
    const networkHosts = capability.allowedNetworkHosts ?? this.networkHosts;
    if (capability.allowedNetworkHosts !== undefined && (!Array.isArray(capability.allowedNetworkHosts) || capability.allowedNetworkHosts.some((host) => typeof host !== "string" || host.length === 0 || CONTROL_PATTERN.test(host)))) return "POLICY_INVALID";
    if (capability.networkAccess === "allowlisted" && (networkHosts.length === 0 || networkHosts.some((host) => typeof host !== "string" || host.length === 0 || CONTROL_PATTERN.test(host)))) return "NETWORK_POLICY_DENIED";
    if (Object.keys(command.environment ?? {}).some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || DANGEROUS_ENVIRONMENT_KEY.test(key) || typeof command.environment?.[key] !== "string" || CONTROL_PATTERN.test(command.environment[key]))) return "POLICY_INVALID";
    if ((command.args ?? []).some(isPathEscape)) return "ARGUMENT_PATH_ESCAPE";
    if (command.workingDirectory !== undefined && isPathEscape(command.workingDirectory)) return "FILESYSTEM_BOUNDARY";
    return undefined;
  }

  private validResourceLimits(limits: ResourceLimits): boolean {
    return Number.isSafeInteger(limits.maxOutputBytes) && limits.maxOutputBytes > 0
      && Number.isSafeInteger(limits.maxProcesses) && limits.maxProcesses > 0
      && (limits.maxMemoryBytes === undefined || (Number.isSafeInteger(limits.maxMemoryBytes) && limits.maxMemoryBytes > 0))
      && (limits.maxCpuMs === undefined || (Number.isSafeInteger(limits.maxCpuMs) && limits.maxCpuMs > 0));
  }

  private async resolveWorkingDirectory(workingDirectory: string | undefined): Promise<string> {
    if (!this.root) throw new Error("filesystem boundary");
    const root = await this.filesystem.realpath(this.root);
    const requested = resolve(root, workingDirectory ?? ".");
    if (!isInside(root, requested)) throw new Error("filesystem boundary");
    const current = await this.filesystem.realpath(requested);
    if (!isInside(root, current)) throw new Error("filesystem boundary");
    let cursor = root;
    const parts = relative(root, requested).split(sep).filter(Boolean);
    for (const part of parts) {
      cursor = resolve(cursor, part);
      const info = await this.filesystem.lstat(cursor);
      if (info.isSymbolicLink()) throw new Error("symlink");
    }
    return current;
  }
}

export const LocalProcessAdapter = localProcessAdapter;

/**
 * Compatibility adapter for the Phase 2 snapshot port. Snapshot resolution and
 * legacy failure names are the only differences from the hardened executor.
 */
export interface BoundedCommandExecutorOptions extends Omit<CommandExecutorOptions, "workspaceRoot" | "now"> {
  readonly snapshotProvider: SnapshotWorkspaceProvider;
  readonly clock?: () => string;
  readonly maxOutputBytes?: number;
  /** @deprecated Ambient/custom host PATH is deliberately not forwarded. */
  readonly path?: string;
}

export interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export class BoundedCommandExecutor implements CommandExecutorPort {
  private readonly outputs = new Map<string, CommandOutput>();

  public constructor(private readonly options: BoundedCommandExecutorOptions) {
    if (options.maxOutputBytes !== undefined && (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1)) throw new Error("maxOutputBytes must be positive");
  }

  public async execute(request: CommandExecutionRequest): Promise<CommandExecution> {
    let workspace: string | undefined;
    try {
      workspace = this.options.snapshotProvider.getSnapshotWorkspace(request.snapshotId);
    } catch {
      // Provider errors can contain host paths; treat unavailable snapshots alike.
    }
    const executor = new CommandExecutor({
      ...this.options,
      // An unknown snapshot must not fall back to cwd even with a test adapter.
      workspaceRoot: workspace ?? "",
      ...(this.options.clock ? { now: () => new Date(this.options.clock!()) } : {}),
      resourceLimits: {
        ...this.options.resourceLimits,
        ...(this.options.maxOutputBytes === undefined ? {} : { maxOutputBytes: this.options.maxOutputBytes }),
      },
    });
    const result = await executor.execute(request);
    const legacyCodes: Readonly<Record<string, string>> = {
      COMMAND_NOT_ALLOWLISTED: "COMMAND_NOT_ALLOWED",
      FILESYSTEM_BOUNDARY: "WORKING_DIRECTORY_DENIED",
      COMMAND_FAILED: "NONZERO_EXIT",
      TIMED_OUT: "TIMEOUT",
    };
    const { contentHash: _contentHash, ...body } = result;
    const failure = result.failure?.code === "FILESYSTEM_BOUNDARY" && workspace === undefined
      ? { code: "SNAPSHOT_NOT_FOUND", message: "Snapshot is not available." }
      : result.failure ? { ...result.failure, code: legacyCodes[result.failure.code] ?? result.failure.code } : undefined;
    const withoutHash = { ...body, ...(failure ? { failure } : {}) };
    const execution = { ...withoutHash, contentHash: sha256(withoutHash as unknown as JsonValue) };
    this.outputs.set(execution.id, executor.getOutput(result.id) ?? { stdout: "", stderr: "" });
    return execution;
  }

  public getOutput(executionId: string): CommandOutput | undefined {
    return this.outputs.get(executionId);
  }
}

export const CommandExecutorAdapter = BoundedCommandExecutor;
export const RepositoryCommandExecutor = BoundedCommandExecutor;
