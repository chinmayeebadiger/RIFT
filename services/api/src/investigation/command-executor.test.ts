import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoundedCommandExecutor } from "./command-executor.js";
import { RepositorySnapshotReaderAdapter } from "./repository-snapshot.js";

const temporaryDirectories: string[] = [];

async function createRepository(): Promise<{ readonly directory: string; readonly revision: string }> {
  const directory = await mkdtemp(join(tmpdir(), "rift-command-repository-"));
  temporaryDirectories.push(directory);
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "tests@example.invalid"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "RIFT tests"], { cwd: directory });
  await writeFile(join(directory, "src.ts"), "source\n");
  execFileSync("git", ["add", "src.ts"], { cwd: directory });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: directory });
  return { directory, revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim() };
}

function snapshotRequest(revision: string) {
  return {
    incidentId: "incident-command",
    correlationId: "correlation-command",
    repositoryRevision: { repository: "fixture", revision },
    capability: { repositoryRevision: { repository: "fixture", revision }, allowedPaths: ["src.ts"] },
  } as const;
}

function commandRequest(snapshotId: string, command: { command: string; args?: readonly string[]; workingDirectory?: string }) {
  return {
    incidentId: "incident-command",
    correlationId: "correlation-command",
    snapshotId,
    command,
    capability: { allowedCommands: [process.execPath], networkAccess: "disabled" as const, timeoutMs: 5_000 },
  } as const;
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe("BoundedCommandExecutor", () => {
  it("classifies a failed reproduction command and preserves its output separately", async () => {
    const fixture = await createRepository();
    const reader = new RepositorySnapshotReaderAdapter({ repositoryRoot: fixture.directory, clock: () => "2026-01-01T00:00:00.000Z" });
    const snapshot = await reader.read(snapshotRequest(fixture.revision)) as { readonly id: string };
    const executor = new BoundedCommandExecutor({ snapshotProvider: reader, clock: () => "2026-01-01T00:00:01.000Z" });

    const execution = await executor.execute(commandRequest(snapshot.id, {
      command: process.execPath,
      args: ["-e", "console.error('boom'); process.exit(7)"],
    })) as { readonly status: string; readonly exitCode: number | null; readonly id: string; readonly failure?: { code: string } };

    expect(execution.status).toBe("failed");
    expect(execution.exitCode).toBe(7);
    expect(execution.failure?.code).toBe("NONZERO_EXIT");
    expect(executor.getOutput(execution.id)).toEqual({ stdout: "", stderr: "boom\n" });
  });

  it("runs in the disposable pinned workspace and cannot modify the host working tree", async () => {
    const fixture = await createRepository();
    const reader = new RepositorySnapshotReaderAdapter({ repositoryRoot: fixture.directory, clock: () => "2026-01-01T00:00:00.000Z" });
    const snapshot = await reader.read(snapshotRequest(fixture.revision)) as { readonly id: string };
    const executor = new BoundedCommandExecutor({ snapshotProvider: reader, clock: () => "2026-01-01T00:00:01.000Z" });

    const execution = await executor.execute(commandRequest(snapshot.id, {
      command: process.execPath,
      args: ["-e", "require('fs').writeFileSync('src.ts', 'changed in snapshot\\n'); require('fs').writeFileSync('generated.txt', 'generated\\n')"],
    })) as { readonly status: string };

    expect(execution.status).toBe("succeeded");
    await expect(readFile(join(fixture.directory, "src.ts"), "utf8")).resolves.toBe("source\n");
    await expect(readFile(join(fixture.directory, "generated.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks commands outside the allowlist and working-directory boundary", async () => {
    const fixture = await createRepository();
    const reader = new RepositorySnapshotReaderAdapter({ repositoryRoot: fixture.directory });
    const snapshot = await reader.read(snapshotRequest(fixture.revision)) as { readonly id: string };
    const executor = new BoundedCommandExecutor({ snapshotProvider: reader });

    const disallowed = await executor.execute({
      ...commandRequest(snapshot.id, { command: "sh", args: ["-c", "true"] }),
      capability: { allowedCommands: [process.execPath], networkAccess: "disabled" as const, timeoutMs: 5_000 },
    }) as { readonly status: string; readonly failure?: { code: string } };
    expect(disallowed.status).toBe("blocked");
    expect(disallowed.failure?.code).toBe("COMMAND_NOT_ALLOWED");

    const escaped = await executor.execute(commandRequest(snapshot.id, { command: process.execPath, workingDirectory: "../" })) as { readonly status: string; readonly failure?: { code: string } };
    expect(escaped.status).toBe("blocked");
    expect(escaped.failure?.code).toBe("WORKING_DIRECTORY_DENIED");
  });
});
