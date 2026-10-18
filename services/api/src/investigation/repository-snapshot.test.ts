import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RepositorySnapshotReaderAdapter } from "./repository-snapshot.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
}

async function createRepository(): Promise<{ readonly directory: string; readonly revision: string }> {
  const directory = await temporaryDirectory("rift-repository-");
  git(directory, "init", "--quiet");
  git(directory, "config", "user.email", "tests@example.invalid");
  git(directory, "config", "user.name", "RIFT tests");
  await writeFile(join(directory, "README.md"), "host working tree\n");
  await writeFile(join(directory, "secret.txt"), "not allowlisted\n");
  await writeFile(join(directory, "src.ts"), "export const value = 'pinned';\n");
  git(directory, "add", "README.md", "secret.txt", "src.ts");
  git(directory, "commit", "--quiet", "-m", "fixture");
  return { directory, revision: git(directory, "rev-parse", "HEAD") };
}

function request(repository: string, revision: string, allowedPaths: readonly string[]) {
  return {
    incidentId: "incident-m2",
    correlationId: "correlation-m2",
    repositoryRevision: { repository: "fixture", revision },
    capability: { repositoryRevision: { repository: "fixture", revision }, allowedPaths },
  } as const;
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe("RepositorySnapshotReaderAdapter", () => {
  it("checks out the pinned revision and fingerprints only allowlisted files", async () => {
    const fixture = await createRepository();
    const reader = new RepositorySnapshotReaderAdapter({
      repositoryRoot: fixture.directory,
      clock: () => "2026-01-01T00:00:00.000Z",
    });

    await writeFile(join(fixture.directory, "src.ts"), "uncommitted host change\n");
    const snapshot = await reader.read(request(fixture.directory, fixture.revision, ["src.ts"]));

    expect(snapshot).toMatchObject({
      kind: "RepositorySnapshot",
      repositoryRevision: { revision: fixture.revision },
      files: [{ path: "src.ts", byteLength: 31 }],
    });
    expect(snapshot).toHaveProperty("contentHash", expect.stringMatching(/^sha256:[0-9a-f]{64}$/u));
    const workspace = reader.getSnapshotWorkspace((snapshot as { id: string }).id);
    expect(workspace).toBeDefined();
    await expect(readFile(join(workspace as string, "src.ts"), "utf8")).resolves.toBe("export const value = 'pinned';\n");
    await expect(readFile(join(fixture.directory, "src.ts"), "utf8")).resolves.toBe("uncommitted host change\n");
    expect((snapshot as { files: readonly { path: string }[] }).files.map((file) => file.path)).toEqual(["src.ts"]);

    const repeated = await reader.read(request(fixture.directory, fixture.revision, ["src.ts"]));
    expect(repeated).toEqual(snapshot);
    await reader.dispose();
  });

  it("rejects a request whose capability is pinned to a different revision", async () => {
    const fixture = await createRepository();
    const reader = new RepositorySnapshotReaderAdapter({ repositoryRoot: fixture.directory });
    const otherRevision = "0123456789abcdef0123456789abcdef01234567";

    await expect(reader.read({
      ...request(fixture.directory, fixture.revision, ["src.ts"]),
      capability: { repositoryRevision: { repository: "fixture", revision: otherRevision }, allowedPaths: ["src.ts"] },
    })).rejects.toMatchObject({ code: "REVISION_MISMATCH" });
    await expect(reader.read(request(fixture.directory, "0123456789abcdef0123456789abcdef01234567", ["src.ts"]))).rejects.toMatchObject({ code: "REVISION_NOT_FOUND" });
  });

  it("rejects traversal, absolute, missing, and symlink paths", async () => {
    const fixture = await createRepository();
    const reader = new RepositorySnapshotReaderAdapter({ repositoryRoot: fixture.directory });

    await expect(reader.read(request(fixture.directory, fixture.revision, ["../secret.txt"]))).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    await expect(reader.read(request(fixture.directory, fixture.revision, ["/etc/passwd"]))).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    await expect(reader.read(request(fixture.directory, fixture.revision, ["missing.txt"]))).rejects.toMatchObject({ code: "PATH_NOT_FOUND" });

    await writeFile(join(fixture.directory, "link-target.txt"), "target\n");
    execFileSync("ln", ["-s", "link-target.txt", "link.txt"], { cwd: fixture.directory });
    git(fixture.directory, "add", "link-target.txt", "link.txt");
    git(fixture.directory, "commit", "--quiet", "-m", "symlink");
    const symlinkRevision = git(fixture.directory, "rev-parse", "HEAD");
    await expect(reader.read(request(fixture.directory, symlinkRevision, ["link.txt"]))).rejects.toMatchObject({ code: "SYMLINK_NOT_ALLOWED" });
  });
});
