import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve, relative, isAbsolute, sep } from "node:path";
import type { CommandExecution, CommandSpec } from "@rift/core";
import type {
  CommandExecutionRequest,
  CommandExecutor as CommandExecutorPort,
} from "./ports.js";

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

function hash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function safeId(value: unknown, fallback: string): string {
  const candidate = typeof value === "string" ? value : fallback;
  const cleaned = candidate.replace(/[^A-Za-z0-9_-]/gu, "-").slice(0, 128);
  return ID_PATTERN.test(cleaned) ? cleaned : fallback;
}

function redact(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) {
    if (secret.length >= 4) result = result.split(secret).join("[REDACTED]");
  }
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
    .filter(([key, value]) => /password|passwd|secret|token|key|auth/iu.test(key) || value.length >= 24)
    .map(([, value]) => value)
    .filter((value) => value.length >= 4);
  return [...new Set(values)];
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
  if (isAbsolute(value) || value.startsWith("~") || CONTROL_PATTERN.test(value)) return true;
  const parts = value.replaceAll("\\", "/").split("/");
  return parts.includes("..") || /(?:^|[=:])\.\.(?:[/\\]|$)/u.test(value) || value.includes("\0");
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function spawnProcessAdapter(spawnCommand: string | undefined, spawnArgs: (spec: ProcessLaunchSpec) => readonly string[], cwd: (spec: ProcessLaunchSpec) => string | undefined): ProcessAdapter {
  return {
    start(spec) {
      const child: ChildProcess = spawn(spawnCommand ?? spec.command, [...spawnArgs(spec)], {
        cwd: cwd(spec),
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...spec.environment },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let outputBytes = 0;
      let resourceLimitExceeded = false;
      const chunks: Buffer[] = [];
      const errorChunks: Buffer[] = [];
      const append = (target: Buffer[], chunk: Buffer): void => {
        outputBytes += chunk.byteLength;
        if (outputBytes > spec.resourceLimits.maxOutputBytes) {
          resourceLimitExceeded = true;
          void kill();
          return;
        }
        target.push(chunk);
      };
      child.stdout?.on("data", (chunk: Buffer) => append(chunks, chunk));
      child.stderr?.on("data", (chunk: Buffer) => append(errorChunks, chunk));
      let killRequested = false;
      const kill = async (): Promise<void> => {
        if (killRequested) return;
        killRequested = true;
        if (!child.killed) child.kill("SIGKILL");
      };
      const abort = (): void => { void kill(); };
      spec.signal.addEventListener("abort", abort, { once: true });
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
          if (!child.killed && child.exitCode === null) await kill();
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
  return spawnProcessAdapter("docker", (spec) => {
    if (spec.networkAccess === "allowlisted") {
      throw new Error("allowlisted network requires a configured egress proxy");
    }
    const args = [
      "run", "--rm", "--init", "--network=none", "--read-only",
      "--cap-drop=ALL", "--security-opt=no-new-privileges",
      `--pids-limit=${spec.resourceLimits.maxProcesses}`,
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
      "--mount", `type=bind,src=${spec.cwd},dst=/workspace,readonly`,
      "--workdir", "/workspace",
    ];
    if (spec.resourceLimits.maxMemoryBytes !== undefined) args.push(`--memory=${spec.resourceLimits.maxMemoryBytes}`);
    if (spec.resourceLimits.maxCpuMs !== undefined) args.push(`--cpus=${Math.max(spec.resourceLimits.maxCpuMs / 1000, 0.001)}`);
    // Values travel in the child environment, not in Docker's argv where they
    // would be visible to host process-list observers.
    for (const key of Object.keys(spec.environment)) args.push("--env", key);
    return [...args, image, spec.command, ...spec.args];
  }, () => undefined);
}

export class CommandExecutor implements CommandExecutorPort {
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

  public async execute(request: CommandExecutionRequest): Promise<unknown> {
    const startedAt = this.clock().toISOString();
    const command = safeCommand(request.command);
    let status: CommandExecution["status"] = "blocked";
    let exitCode: number | null = null;
    let code: FailureCode | undefined;
    let handle: ProcessHandle | undefined;
    let timedOut = false;
    let cleanupFailed = false;
    const controller = new AbortController();
    const requestSignal = request.signal;
    const abortRequest = (): void => controller.abort();
    const abortProcess = (): void => { if (handle) void handle.kill(); };
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
        const networkHosts = capability.allowedNetworkHosts ?? this.networkHosts;
        if (!this.validResourceLimits(limits)) {
          code = "PROCESS_LIMIT_EXCEEDED";
        } else {
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
          if (controller.signal.aborted) void handle.kill();
          const timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
            void handle?.kill();
          }, request.capability.timeoutMs);
          try {
            const result = await handle.completion;
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
            status = requestSignal?.aborted ? "cancelled" : "failed";
            code = requestSignal?.aborted ? "CANCELLED" : "EXECUTION_ERROR";
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
    return { ...body, contentHash: hash(body) } satisfies CommandExecution;
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
    if (Object.keys(command.environment ?? {}).some((key) => DANGEROUS_ENVIRONMENT_KEY.test(key) || CONTROL_PATTERN.test(key) || typeof command.environment?.[key] !== "string" || CONTROL_PATTERN.test(command.environment[key]))) return "POLICY_INVALID";
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
