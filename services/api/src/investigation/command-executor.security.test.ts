import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@rift/core";
import { sha256 } from "../domain/hashing.js";
import type { CommandExecutionRequest } from "./ports.js";
import {
  CommandExecutor,
  BoundedCommandExecutor,
  LocalProcessAdapter,
  type FilesystemAdapter,
  type ProcessLaunchSpec,
  type ProcessAdapter,
  type ProcessExit,
  type ProcessHandle,
} from "./command-executor.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

afterEach(() => { vi.unstubAllEnvs(); });

function dockerChild(waitForKill = false): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null,
    kill: vi.fn(() => { queueMicrotask(() => child.emit("close", null, "SIGKILL")); return true; }),
  });
  if (!waitForKill) queueMicrotask(() => { child.exitCode = 0; child.emit("close", 0, null); });
  return child as unknown as ChildProcess;
}

const request = (overrides: Partial<CommandExecutionRequest> = {}): CommandExecutionRequest => ({
  incidentId: "incident-1",
  correlationId: "correlation-1",
  snapshotId: "snapshot-1",
  command: { command: "node", args: ["-e", "process.stdout.write('ok')"] },
  capability: { allowedCommands: ["node"], networkAccess: "disabled", timeoutMs: 1000 },
  ...overrides,
});

function adapter(result: ProcessExit, onKill = vi.fn(), onCleanup = vi.fn()): ProcessAdapter {
  return {
    start: vi.fn((): ProcessHandle => ({
      completion: Promise.resolve(result),
      kill: onKill,
      cleanup: onCleanup,
    })),
  };
}

describe("CommandExecutor security policy", () => {
  it("fails closed for unauthorized commands and malformed policy", async () => {
    const start = vi.fn();
    const executor = new CommandExecutor({ processAdapter: { start } });
    const result = await executor.execute(request({ command: { command: "sh", args: ["-c", "id"] } }));
    expect(result).toMatchObject({ status: "blocked", failure: { code: "COMMAND_NOT_ALLOWLISTED" } });
    expect(start).not.toHaveBeenCalled();
  });

  it("rejects network access unless an explicit allowlist is configured", async () => {
    const executor = new CommandExecutor({ processAdapter: adapter({ exitCode: 0 }), allowlistedNetworkHosts: [] });
    const result = await executor.execute(request({ capability: { allowedCommands: ["node"], networkAccess: "allowlisted", timeoutMs: 1000 } }));
    expect(result).toMatchObject({ status: "blocked", failure: { code: "NETWORK_POLICY_DENIED" } });

    const start = vi.fn((spec: ProcessLaunchSpec) => {
      expect(spec.networkAccess).toBe("allowlisted");
      expect(spec.allowedNetworkHosts).toEqual(["registry.example.test"]);
      return adapter({ exitCode: 0 }).start(spec);
    });
    const allowlisted = new CommandExecutor({ processAdapter: { start } });
    await expect(allowlisted.execute(request({
      capability: {
        allowedCommands: ["node"],
        networkAccess: "allowlisted",
        allowedNetworkHosts: ["registry.example.test"],
        timeoutMs: 1000,
      },
    }))).resolves.toMatchObject({ status: "succeeded" });
  });

  it("prevents path traversal and symlink traversal", async () => {
    const start = vi.fn();
    const filesystem: FilesystemAdapter = {
      realpath: vi.fn(async (path: string) => path),
      lstat: vi.fn(async () => ({ isSymbolicLink: () => true })),
    };
    const executor = new CommandExecutor({ workspaceRoot: "/workspace", filesystemAdapter: filesystem, processAdapter: { start } });
    const traversal = await executor.execute(request({ command: { command: "node", args: ["../escape"] } }));
    expect(traversal).toMatchObject({ status: "blocked", failure: { code: "ARGUMENT_PATH_ESCAPE" } });
    const symlink = await executor.execute(request({ command: { command: "node", workingDirectory: "link" } }));
    expect(symlink).toMatchObject({ status: "blocked", failure: { code: "SYMLINK_NOT_ALLOWED" } });
    expect(start).not.toHaveBeenCalled();
  });

  it("maps timeout, cancellation, and resource-limit results without leaking output", async () => {
    const abort = new AbortController();
    let resolveCompletion!: (value: ProcessExit) => void;
    const kill = vi.fn();
    const cleanup = vi.fn();
    const processAdapter: ProcessAdapter = {
      start: vi.fn((): ProcessHandle => ({
        completion: new Promise<ProcessExit>((resolve) => { resolveCompletion = resolve; }),
        kill,
        cleanup,
      })),
    };
    const timeoutExecutor = new CommandExecutor({ processAdapter, now: () => new Date("2026-10-18T10:00:00.000Z") });
    const pending = timeoutExecutor.execute(request({ capability: { allowedCommands: ["node"], networkAccess: "disabled", timeoutMs: 1 } }));
    await vi.waitFor(() => expect(processAdapter.start).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 10));
    resolveCompletion({ exitCode: null, signal: "SIGKILL", stdout: "TOKEN=super-secret", stderr: "secret" });
    await expect(pending).resolves.toMatchObject({ status: "timed-out", failure: { code: "TIMED_OUT" } });
    expect(kill).toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalled();

    let resolveCancellation!: (value: ProcessExit) => void;
    const cancellationKill = vi.fn();
    const cancellationCleanup = vi.fn();
    const cancellationAdapter: ProcessAdapter = {
      start: vi.fn((): ProcessHandle => ({
        completion: new Promise<ProcessExit>((resolve) => { resolveCancellation = resolve; }),
        kill: cancellationKill,
        cleanup: cancellationCleanup,
      })),
    };
    const cancelled = new CommandExecutor({ processAdapter: cancellationAdapter });
    const cancellation = cancelled.execute(request({ signal: abort.signal }));
    await vi.waitFor(() => expect(cancellationAdapter.start).toHaveBeenCalled());
    abort.abort();
    resolveCancellation({ exitCode: null, signal: "SIGKILL" });
    await expect(cancellation).resolves.toMatchObject({ status: "cancelled", failure: { code: "CANCELLED" } });
    expect(cancellationKill).toHaveBeenCalled();
    expect(cancellationCleanup).toHaveBeenCalled();

    const limited = new CommandExecutor({ processAdapter: adapter({ exitCode: 1, processLimitExceeded: true, stdout: "secret" }) });
    const limitedResult = await limited.execute(request());
    expect(limitedResult).toMatchObject({ status: "failed", failure: { code: "PROCESS_LIMIT_EXCEEDED" } });
    expect(JSON.stringify(limitedResult)).not.toContain("secret");
    expect(JSON.stringify(limitedResult)).not.toContain("TOKEN");

    const outputLimited = new CommandExecutor({ processAdapter: adapter({ exitCode: null, resourceLimitExceeded: true }) });
    await expect(outputLimited.execute(request())).resolves.toMatchObject({ status: "failed", failure: { code: "OUTPUT_LIMIT_EXCEEDED" } });
  });

  it("reports cleanup failure and never exposes process output", async () => {
    const executor = new CommandExecutor({ processAdapter: adapter({ exitCode: 0, stdout: "password=secret" }, vi.fn(), vi.fn(() => { throw new Error("cleanup path") })) });
    const result = await executor.execute(request({ command: { command: "node", environment: { API_TOKEN: "super-secret-token" } } }));
    expect(result).toMatchObject({ status: "failed", failure: { code: "CLEANUP_FAILED" } });
    expect(JSON.stringify(result)).not.toContain("super-secret-token");
    expect(JSON.stringify(result)).not.toContain("password=secret");
  });

  it("uses Docker by default with a read-only snapshot, no network, and no host secrets or client-config injection", async () => {
    vi.stubEnv("RIFT_AMBIENT_SECRET", "must-not-inherit");
    let input = "";
    const launch = vi.fn((..._args: Parameters<typeof spawn>) => {
      const child = dockerChild();
      child.stdin!.on("data", (chunk: Buffer) => { input += chunk.toString("utf8"); });
      return child;
    });
    vi.mocked(spawn).mockImplementationOnce(launch)
      .mockImplementationOnce(() => dockerChild())
      .mockImplementationOnce(() => dockerChild());
    const executor = new BoundedCommandExecutor({ snapshotProvider: { getSnapshotWorkspace: () => process.cwd() } });
    const result = await executor.execute(request({ command: {
      command: "node", args: ["-e", "process.exit(0)"],
      environment: { API_TOKEN: "private-container-token", DOCKER_HOST: "tcp://untrusted.invalid", HOME: "/untrusted" },
    } }));
    expect(result.status).toBe("succeeded");
    const [command, args, options] = launch.mock.calls[0];
    expect(command).toBe("docker");
    expect(args).toEqual(expect.arrayContaining([
      "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "--env-file", "/dev/stdin", "--pids-limit=2",
    ]));
    expect(args).toContain(`type=bind,src=${process.cwd()},dst=/workspace,readonly`);
    expect(options?.env).toEqual({ PATH: "/usr/local/bin:/usr/bin:/bin" });
    expect(JSON.stringify(args)).not.toContain("private-container-token");
    expect(JSON.stringify(args)).not.toContain("tcp://untrusted.invalid");
    expect(input).toContain("API_TOKEN=private-container-token\n");
    expect(input).toContain("DOCKER_HOST=tcp://untrusted.invalid\n");
    expect(JSON.stringify(result)).not.toContain("private-container-token");
    expect(vi.mocked(spawn).mock.calls.slice(-2).map((call) => call[1]?.slice(0, 2))).toEqual([["rm", "--force"], ["rm", "--force"]]);
  });

  it("forcibly removes a named Docker container on timeout and again after its client exits", async () => {
    const launch = vi.fn(() => dockerChild(true));
    const remove = vi.fn(() => dockerChild());
    vi.mocked(spawn).mockImplementationOnce(launch).mockImplementationOnce(remove).mockImplementationOnce(remove);
    const executor = new BoundedCommandExecutor({ snapshotProvider: { getSnapshotWorkspace: () => process.cwd() } });
    const result = await executor.execute(request({ capability: { allowedCommands: ["node"], networkAccess: "disabled", timeoutMs: 10 } }));
    expect(result).toMatchObject({ status: "timed-out", failure: { code: "TIMEOUT" } });
    expect(remove).toHaveBeenCalledTimes(2);
    const mainArgs = vi.mocked(spawn).mock.calls.at(-3)![1]!;
    const name = mainArgs[mainArgs.indexOf("--name") + 1];
    expect(name).toMatch(/^rift-command-/u);
    for (const call of vi.mocked(spawn).mock.calls.slice(-2)) expect(call[1]).toEqual(["rm", "--force", name]);
  });

  it("does not hang or lose cleanup when an adapter ignores termination or kill rejects", async () => {
    const cleanup = vi.fn();
    const kill = vi.fn(async () => { throw new Error("sensitive adapter detail"); });
    const executor = new CommandExecutor({ processAdapter: { start: () => ({
      completion: new Promise<ProcessExit>(() => undefined), kill, cleanup,
    }) } });
    const result = await executor.execute(request({ capability: { allowedCommands: ["node"], networkAccess: "disabled", timeoutMs: 1 } }));
    expect(result).toMatchObject({ status: "failed", failure: { code: "CLEANUP_FAILED" } });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("sensitive adapter detail");
  });

  it("rejects absolute option paths, invalid environment keys, and pre-cancelled runs before launch", async () => {
    const start = vi.fn();
    const executor = new CommandExecutor({ processAdapter: { start } });
    for (const argument of ["--output=/etc/passwd", "C:\\outside", "--file=../outside"]) {
      await expect(executor.execute(request({ command: { command: "node", args: [argument] } })))
        .resolves.toMatchObject({ status: "blocked", failure: { code: "ARGUMENT_PATH_ESCAPE" } });
    }
    await expect(executor.execute(request({ command: { command: "node", environment: { "INVALID=KEY": "value" } } })))
      .resolves.toMatchObject({ status: "blocked", failure: { code: "POLICY_INVALID" } });
    await expect(executor.execute(request({ signal: AbortSignal.abort() })))
      .resolves.toMatchObject({ status: "cancelled" });
    expect(start).not.toHaveBeenCalled();
  });

  it("redacts secrets from flags and output while hashing only canonical safe metadata", async () => {
    const executor = new CommandExecutor({
      processAdapter: adapter({ exitCode: 7, stdout: "abc inline-token flag-token password=other", stderr: "flag-token" }),
    });
    const result = await executor.execute(request({ command: {
      command: "node", args: ["--token", "flag-token", "--api-key=inline-token"], environment: { API_TOKEN: "abc" },
    } }));
    expect(result.command).toEqual({ command: "node", args: ["--token", "[REDACTED]", "--api-key=[REDACTED]"] });
    expect(executor.getOutput(result.id)).toEqual({ stdout: "[REDACTED] [REDACTED] [REDACTED] [REDACTED]", stderr: "[REDACTED]" });
    const { contentHash, ...body } = result;
    expect(contentHash).toBe(sha256(body as unknown as JsonValue));
    expect(contentHash).toBe(sha256(Object.fromEntries(Object.entries(body).reverse()) as JsonValue));
  });

  it("bounds combined captured stdout and stderr and terminates local process groups on timeout", async () => {
    const executor = new CommandExecutor({ processAdapter: adapter({ exitCode: 0, stdout: "123456", stderr: "789012" }), resourceLimits: { maxOutputBytes: 8 } });
    const result = await executor.execute(request());
    expect(executor.getOutput(result.id)).toEqual({ stdout: "123456", stderr: "78" });
    const local = new CommandExecutor({ processAdapter: LocalProcessAdapter() });
    const timedOut = await local.execute(request({
      command: { command: process.execPath, args: ["-e", "require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'inherit'}); setInterval(() => {}, 1000)"] },
      capability: { allowedCommands: [process.execPath], networkAccess: "disabled", timeoutMs: 250 },
    }));
    expect(timedOut).toMatchObject({ status: "timed-out", failure: { code: "TIMED_OUT" } });
  });

  it("kills an output-flooding local test process and preserves UTF-8 output byte limits", async () => {
    const local = new CommandExecutor({ processAdapter: LocalProcessAdapter(), resourceLimits: { maxOutputBytes: 64 } });
    await expect(local.execute(request({
      command: { command: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000)"] },
      capability: { allowedCommands: [process.execPath], networkAccess: "disabled", timeoutMs: 1000 },
    }))).resolves.toMatchObject({ status: "failed", failure: { code: "OUTPUT_LIMIT_EXCEEDED" } });

    const unicode = new CommandExecutor({ processAdapter: adapter({ exitCode: 0, stdout: "€€", stderr: "€" }), resourceLimits: { maxOutputBytes: 5 } });
    const result = await unicode.execute(request());
    const output = unicode.getOutput(result.id)!;
    expect(Buffer.byteLength(output.stdout + output.stderr)).toBeLessThanOrEqual(5);
    expect(output).toEqual({ stdout: "€", stderr: "" });
  });

  it("applies shared evidence redaction to credentials discovered only in process output", async () => {
    const executor = new CommandExecutor({ processAdapter: adapter({
      exitCode: 7,
      stdout: "Authorization: Bearer undisclosed-credential\nghp_unlistedCredential\npostgres://user:password@database.invalid/db",
      stderr: "-----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY-----",
    }) });
    const result = await executor.execute(request());
    const serialized = JSON.stringify(executor.getOutput(result.id));
    for (const secret of ["undisclosed-credential", "ghp_unlistedCredential", "user:password", "private material"]) expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");
  });
});
