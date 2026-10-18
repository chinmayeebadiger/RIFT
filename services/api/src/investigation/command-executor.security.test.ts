import { describe, expect, it, vi } from "vitest";
import type { CommandExecutionRequest } from "./ports.js";
import {
  CommandExecutor,
  type FilesystemAdapter,
  type ProcessLaunchSpec,
  type ProcessAdapter,
  type ProcessExit,
  type ProcessHandle,
} from "./command-executor.js";

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
});
