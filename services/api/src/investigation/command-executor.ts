import { spawn, type ChildProcess } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CommandExecution, CommandExecutionStatus, CommandSpec, JsonValue, Sha256Hash } from "@rift/core";
import { sha256 } from "../domain/hashing.js";
import type { CommandExecutor, CommandExecutionRequest } from "./ports.js";
import type { SnapshotWorkspaceProvider } from "./repository-snapshot.js";

const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_OUTPUT_BYTES = 1024 * 1024;
const SHELL_METACHARACTERS = /[;&|`$<>\n\r]/u;
const NETWORK_COMMANDS = new Set(["curl", "wget", "nc", "netcat", "ssh", "scp", "telnet"]);

export interface CommandExecutorOptions {
  readonly snapshotProvider: SnapshotWorkspaceProvider;
  readonly clock?: () => string;
  readonly maxOutputBytes?: number;
  readonly path?: string;
}

export interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export class CommandExecutorError extends Error {
  public constructor(
    message: string,
    public readonly code:
      | "INVALID_REQUEST"
      | "SNAPSHOT_NOT_FOUND"
      | "POLICY_DENIED"
      | "WORKING_DIRECTORY_DENIED"
      | "OUTPUT_LIMIT_EXCEEDED",
  ) {
    super(message);
    this.name = "CommandExecutorError";
  }
}

interface ProcessResult {
  readonly status: CommandExecutionStatus;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly failure?: { readonly code: string; readonly message: string };
}

function idFromHash(prefix: string, value: Sha256Hash): string {
  return `${prefix}-${value.slice("sha256:".length, "sha256:".length + 32)}`;
}

function isWithin(root: string, candidate: string): boolean {
  const result = relative(root, candidate);
  return result === "" || (result !== ".." && !result.startsWith(`..${sep}`) && !isAbsolute(result));
}

function validateCommand(command: CommandSpec): void {
  if (typeof command.command !== "string" || command.command.length === 0 || SHELL_METACHARACTERS.test(command.command)) {
    throw new CommandExecutorError("command is not a single executable name", "INVALID_REQUEST");
  }
  if (command.args !== undefined && (!Array.isArray(command.args) || command.args.length > 64 || command.args.some((arg) => typeof arg !== "string"))) {
    throw new CommandExecutorError("command arguments are invalid or exceed the bound", "INVALID_REQUEST");
  }
  if (command.workingDirectory !== undefined) {
    if (
      command.workingDirectory.length === 0 ||
      command.workingDirectory.includes("\\") ||
      command.workingDirectory.includes("\u0000") ||
      isAbsolute(command.workingDirectory) ||
      command.workingDirectory.split("/").some((part) => part === ".." || part === "")
    ) {
      throw new CommandExecutorError("workingDirectory must be a relative path", "WORKING_DIRECTORY_DENIED");
    }
  }
}

function failure(code: string, message: string): { readonly code: string; readonly message: string } {
  return { code, message };
}

function now(clock?: () => string): string {
  return clock?.() ?? new Date().toISOString();
}

function terminate(child: ChildProcess): void {
  if (child.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The process may have already exited; fall back to the direct handle.
    }
  }
  child.kill("SIGKILL");
}

function boundedBuffer(chunks: Buffer[], size: number, max: number): { readonly value: Buffer; readonly exceeded: boolean } {
  if (size > max) return { value: Buffer.concat(chunks, Math.min(size, max)).subarray(0, max), exceeded: true };
  return { value: Buffer.concat(chunks, size), exceeded: false };
}

export class BoundedCommandExecutor implements CommandExecutor {
  private readonly snapshotProvider: SnapshotWorkspaceProvider;
  private readonly clock?: () => string;
  private readonly maxOutputBytes: number;
  private readonly executablePath: string;
  private readonly outputs = new Map<string, CommandOutput>();

  public constructor(options: CommandExecutorOptions) {
    this.snapshotProvider = options.snapshotProvider;
    this.clock = options.clock;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
    if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes < 1) {
      throw new CommandExecutorError("maxOutputBytes must be a positive integer", "INVALID_REQUEST");
    }
    this.executablePath = options.path ?? process.env.PATH ?? "";
  }

  public async execute(request: CommandExecutionRequest): Promise<unknown> {
    const startedAt = now(this.clock);
    let result: ProcessResult;
    try {
      validateCommand(request.command);
      if (request.signal?.aborted) {
        result = { status: "cancelled", exitCode: null, stdout: "", stderr: "", failure: failure("CANCELLED", "command execution was cancelled") };
      } else if (!Array.isArray(request.capability.allowedCommands) || !request.capability.allowedCommands.includes(request.command.command)) {
        result = this.blocked(request.command, "COMMAND_NOT_ALLOWED", `command is not allowed: ${request.command.command}`);
      } else if (request.capability.networkAccess !== "disabled" && request.capability.networkAccess !== "allowlisted") {
        result = this.blocked(request.command, "NETWORK_POLICY_INVALID", "network access policy is invalid");
      } else if (request.capability.networkAccess === "disabled" && NETWORK_COMMANDS.has(request.command.command)) {
        result = this.blocked(request.command, "NETWORK_DISABLED", `network command is blocked: ${request.command.command}`);
      } else {
        const workspace = this.snapshotProvider.getSnapshotWorkspace(request.snapshotId);
        if (workspace === undefined) {
          result = this.blocked(request.command, "SNAPSHOT_NOT_FOUND", `snapshot is not available: ${request.snapshotId}`);
        } else {
          const workingDirectory = await this.resolveWorkingDirectory(workspace, request.command);
          if (workingDirectory === undefined) {
            result = this.blocked(request.command, "WORKING_DIRECTORY_DENIED", "working directory escapes the snapshot workspace");
          } else {
            const timeoutMs = request.capability.timeoutMs;
            if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
              result = this.blocked(request.command, "TIMEOUT_INVALID", "command timeout is outside the allowed bound");
            } else {
              result = await this.run(request, workingDirectory, timeoutMs);
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof CommandExecutorError) {
        result = this.blocked(request.command, error.code, error.message);
      } else {
        result = {
          status: "failed",
          exitCode: null,
          stdout: "",
          stderr: "",
          failure: failure("EXECUTOR_ERROR", error instanceof Error ? error.message : "command execution failed"),
        };
      }
    }

    const finishedAt = now(this.clock);
    const executionFingerprint = sha256({
      incidentId: request.incidentId,
      correlationId: request.correlationId,
      snapshotId: request.snapshotId,
      command: request.command,
      status: result.status,
      exitCode: result.exitCode,
      startedAt,
      finishedAt,
      ...(result.failure === undefined ? {} : { failure: result.failure }),
    } as unknown as JsonValue);
    const withoutHash = {
      schemaVersion: 1 as const,
      id: idFromHash("execution", executionFingerprint),
      incidentId: request.incidentId,
      correlationId: request.correlationId,
      createdAt: finishedAt,
      kind: "CommandExecution" as const,
      snapshotId: request.snapshotId,
      command: request.command,
      status: result.status,
      exitCode: result.exitCode,
      startedAt,
      finishedAt,
      ...(result.failure === undefined ? {} : { failure: result.failure }),
      evidenceIds: [],
    };
    const contentHash = sha256(withoutHash as unknown as JsonValue);
    const execution: CommandExecution = {
      ...withoutHash,
      contentHash,
    };
    this.outputs.set(execution.id, { stdout: result.stdout, stderr: result.stderr });
    return execution;
  }

  public getOutput(executionId: string): CommandOutput | undefined {
    return this.outputs.get(executionId);
  }

  private blocked(command: CommandSpec, code: string, message: string): ProcessResult {
    return { status: "blocked", exitCode: null, stdout: "", stderr: "", failure: failure(code, message) };
  }

  private async resolveWorkingDirectory(workspace: string, command: CommandSpec): Promise<string | undefined> {
    const root = resolve(workspace);
    const candidate = resolve(root, command.workingDirectory ?? ".");
    if (!isWithin(root, candidate)) return undefined;
    try {
      const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
      return isWithin(realRoot, realCandidate) ? realCandidate : undefined;
    } catch {
      return undefined;
    }
  }

  private run(request: CommandExecutionRequest, workingDirectory: string, timeoutMs: number): Promise<ProcessResult> {
    const env: Record<string, string> = {
      CI: "1",
      PATH: this.executablePath,
      RIFT_NETWORK_ACCESS: request.capability.networkAccess,
      NPM_CONFIG_OFFLINE: request.capability.networkAccess === "disabled" ? "true" : "false",
      NPM_CONFIG_AUDIT: "false",
      NPM_CONFIG_FUND: "false",
      GIT_TERMINAL_PROMPT: "0",
    };
    for (const [key, value] of Object.entries(request.command.environment ?? {})) {
      if (/^(?:HOME|TMPDIR|TMP|TEMP|PWD|OLDPWD)$/u.test(key)) continue;
      env[key] = value;
    }
    env.HOME = join(workingDirectory, ".home");
    env.TMPDIR = join(workingDirectory, ".tmp");

    return new Promise<ProcessResult>((resolveResult) => {
      const child = spawn(request.command.command, [...(request.command.args ?? [])], {
        cwd: workingDirectory,
        env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      let outputExceeded = false;
      const timer = setTimeout(() => {
        timedOut = true;
        terminate(child);
      }, timeoutMs);
      const abort = () => {
        cancelled = true;
        terminate(child);
      };
      request.signal?.addEventListener("abort", abort, { once: true });
      const settle = (result: ProcessResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", abort);
        resolveResult(result);
      };
      const collect = (chunks: Buffer[], data: Buffer, currentSize: number, kind: "stdout" | "stderr") => {
        const nextSize = currentSize + data.byteLength;
        if (nextSize <= this.maxOutputBytes) chunks.push(data);
        else outputExceeded = true;
        return kind === "stdout" ? nextSize : nextSize;
      };
      child.stdout?.on("data", (data: Buffer) => {
        stdoutBytes = collect(stdoutChunks, data, stdoutBytes, "stdout");
        if (outputExceeded) terminate(child);
      });
      child.stderr?.on("data", (data: Buffer) => {
        stderrBytes = collect(stderrChunks, data, stderrBytes, "stderr");
        if (outputExceeded) terminate(child);
      });
      child.on("error", (error) => {
        settle({ status: cancelled ? "cancelled" : timedOut ? "timed-out" : "failed", exitCode: null, stdout: "", stderr: "", failure: failure("SPAWN_FAILED", error.message) });
      });
      child.on("close", (code) => {
        const stdout = boundedBuffer(stdoutChunks, stdoutBytes, this.maxOutputBytes).value.toString("utf8");
        const stderr = boundedBuffer(stderrChunks, stderrBytes, this.maxOutputBytes).value.toString("utf8");
        if (cancelled) settle({ status: "cancelled", exitCode: null, stdout, stderr, failure: failure("CANCELLED", "command execution was cancelled") });
        else if (timedOut) settle({ status: "timed-out", exitCode: null, stdout, stderr, failure: failure("TIMEOUT", `command exceeded ${timeoutMs}ms`) });
        else if (outputExceeded) settle({ status: "failed", exitCode: null, stdout, stderr, failure: failure("OUTPUT_LIMIT_EXCEEDED", "command output exceeded the configured bound") });
        else if (code === 0) settle({ status: "succeeded", exitCode: 0, stdout, stderr });
        else settle({ status: "failed", exitCode: code, stdout, stderr, failure: failure("NONZERO_EXIT", `command exited with code ${code ?? "unknown"}`) });
      });
    });
  }
}

export const CommandExecutorAdapter = BoundedCommandExecutor;
export const RepositoryCommandExecutor = BoundedCommandExecutor;
