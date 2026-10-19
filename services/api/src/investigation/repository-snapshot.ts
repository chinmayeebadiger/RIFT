import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  JsonValue,
  RepositoryRevision,
  RepositorySnapshot,
  RepositorySnapshotFile,
  Sha256Hash,
} from "@rift/core";
import { sha256 } from "../domain/hashing.js";
import type { RepositoryReadCapability, RepositorySnapshotReader, RepositorySnapshotRequest } from "./ports.js";

const execFileAsync = promisify(execFile);
const SNAPSHOT_SCHEMA_VERSION = 1 as const;
const DEFAULT_ADAPTER_NAME = "git-repository-snapshot";
const DEFAULT_ADAPTER_VERSION = "1";

export interface RepositorySnapshotReaderOptions {
  readonly repositoryRoot: string;
  readonly snapshotRoot?: string;
  readonly adapterName?: string;
  readonly adapterVersion?: string;
  readonly clock?: () => string;
}

export interface SnapshotWorkspaceProvider {
  getSnapshotWorkspace(snapshotId: string): string | undefined;
}

export class RepositorySnapshotError extends Error {
  public constructor(
    message: string,
    public readonly code:
      | "INVALID_REQUEST"
      | "REVISION_NOT_FOUND"
      | "REVISION_MISMATCH"
      | "PATH_NOT_ALLOWED"
      | "PATH_NOT_FOUND"
      | "SYMLINK_NOT_ALLOWED"
      | "UNSUPPORTED_ENTRY"
      | "SNAPSHOT_IO",
  ) {
    super(message);
    this.name = "RepositorySnapshotError";
  }
}

interface GitEntry {
  readonly mode: string;
  readonly type: "blob" | "tree" | "commit";
  readonly objectId: string;
  readonly path: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateRevision(value: unknown, path: string): asserts value is RepositoryRevision {
  if (!isRecord(value) || typeof value.repository !== "string" || value.repository.length === 0 || typeof value.revision !== "string") {
    throw new RepositorySnapshotError(`${path} must contain a repository and revision`, "INVALID_REQUEST");
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value.revision)) {
    throw new RepositorySnapshotError(`${path}.revision is not a pinned Git revision`, "INVALID_REQUEST");
  }
}

function validateRelativePath(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\u0000") || isAbsolute(value)) {
    throw new RepositorySnapshotError(`${path} is not an allowed relative path`, "PATH_NOT_ALLOWED");
  }
  const parts = value.split("/");
  if (parts.some((part) => part === ".." || part === "")) {
    throw new RepositorySnapshotError(`${path} is not an allowed relative path`, "PATH_NOT_ALLOWED");
  }
}

function validateCapability(request: RepositorySnapshotRequest): void {
  validateRevision(request.repositoryRevision, "repositoryRevision");
  validateRevision(request.capability.repositoryRevision, "capability.repositoryRevision");
  if (
    request.repositoryRevision.repository !== request.capability.repositoryRevision.repository ||
    request.repositoryRevision.revision !== request.capability.repositoryRevision.revision
  ) {
    throw new RepositorySnapshotError("request and capability revisions do not match", "REVISION_MISMATCH");
  }
  if (!Array.isArray(request.capability.allowedPaths) || request.capability.allowedPaths.length === 0) {
    throw new RepositorySnapshotError("at least one allowed path is required", "PATH_NOT_ALLOWED");
  }
  const seen = new Set<string>();
  for (const [index, path] of request.capability.allowedPaths.entries()) {
    validateRelativePath(path, `capability.allowedPaths[${index}]`);
    if (seen.has(path)) throw new RepositorySnapshotError(`duplicate allowed path: ${path}`, "PATH_NOT_ALLOWED");
    seen.add(path);
  }
}

function sha256Bytes(value: Uint8Array): Sha256Hash {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function idFromHash(prefix: string, hash: Sha256Hash): string {
  return `${prefix}-${hash.slice("sha256:".length, "sha256:".length + 32)}`;
}

function commandError(error: unknown): string {
  if (isRecord(error) && typeof error.stderr === "string" && error.stderr.length > 0) return error.stderr.trim();
  return error instanceof Error ? error.message : "Git command failed";
}

async function gitBuffer(repositoryRoot: string, args: readonly string[]): Promise<Buffer> {
  try {
    const result = await execFileAsync("git", ["--no-replace-objects", ...args], {
      cwd: repositoryRoot,
      encoding: "buffer",
      maxBuffer: 128 * 1024 * 1024,
      windowsHide: true,
    });
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
  } catch (error) {
    throw new RepositorySnapshotError(commandError(error), "SNAPSHOT_IO");
  }
}

function parseTreeEntries(output: Buffer): GitEntry[] {
  const entries: GitEntry[] = [];
  const text = output.toString("utf8");
  if (output.length === 0) return entries;
  if (!text.endsWith("\u0000") || !Buffer.from(text, "utf8").equals(output)) throw new RepositorySnapshotError("Git returned an invalid tree listing", "SNAPSHOT_IO");
  for (const record of text.split("\u0000")) {
    if (record.length === 0) continue;
    const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]+)\t(.+)$/u.exec(record);
    if (match === null) throw new RepositorySnapshotError("Git returned an invalid tree entry", "SNAPSHOT_IO");
    entries.push({ mode: match[1], type: match[2] as GitEntry["type"], objectId: match[3], path: match[4] });
  }
  return entries;
}

function isWithin(root: string, candidate: string): boolean {
  const result = relative(root, candidate);
  return result === "" || (result !== ".." && !result.startsWith(`..${sep}`) && !isAbsolute(result));
}

function commitTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new RepositorySnapshotError("Git returned an invalid commit timestamp", "SNAPSHOT_IO");
  return date.toISOString();
}

/**
 * Git-backed, read-only source view. Files are materialised from Git objects
 * into a disposable directory; the caller's checkout is never used as the
 * command working directory and is never modified.
 */
export class RepositorySnapshotReaderAdapter implements RepositorySnapshotReader, SnapshotWorkspaceProvider {
  private readonly repositoryRoot: string;
  private readonly snapshotRoot?: string;
  private readonly adapter: { readonly name: string; readonly version: string };
  private readonly clock?: () => string;
  private readonly workspaces = new Map<string, string>();

  public constructor(options: RepositorySnapshotReaderOptions) {
    if (!isAbsolute(options.repositoryRoot)) throw new RepositorySnapshotError("repositoryRoot must be absolute", "INVALID_REQUEST");
    this.repositoryRoot = resolve(options.repositoryRoot);
    this.snapshotRoot = options.snapshotRoot === undefined ? undefined : resolve(options.snapshotRoot);
    this.adapter = {
      name: options.adapterName ?? DEFAULT_ADAPTER_NAME,
      version: options.adapterVersion ?? DEFAULT_ADAPTER_VERSION,
    };
    this.clock = options.clock;
  }

  public async read(request: RepositorySnapshotRequest): Promise<unknown> {
    validateCapability(request);
    if (request.signal?.aborted) throw new RepositorySnapshotError("snapshot read was cancelled", "SNAPSHOT_IO");

    const revision = request.repositoryRevision;
    let resolvedRevision: string;
    try {
      resolvedRevision = (await gitBuffer(this.repositoryRoot, ["rev-parse", "--verify", `${revision.revision}^{commit}`])).toString("utf8").trim();
    } catch (error) {
      if (error instanceof RepositorySnapshotError) throw new RepositorySnapshotError("pinned revision was not found", "REVISION_NOT_FOUND");
      throw error;
    }
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(resolvedRevision) || resolvedRevision !== revision.revision) {
      throw new RepositorySnapshotError("Git did not resolve a commit", "REVISION_NOT_FOUND");
    }
    const commitDate = (await gitBuffer(this.repositoryRoot, ["show", "-s", "--format=%cI", resolvedRevision])).toString("utf8").trim();
    const createdAt = this.clock?.() ?? commitTimestamp(commitDate);
    const allowedPaths = [...request.capability.allowedPaths].sort();
    const entries = parseTreeEntries(await gitBuffer(this.repositoryRoot, ["ls-tree", "-rz", "-r", "--full-tree", resolvedRevision, "--", ...allowedPaths]));
    const files = entries.filter((entry) => entry.type === "blob");
    const matchedPaths = new Set<string>();
    for (const entry of entries) {
      if (entry.path.split("/").includes(".git")) throw new RepositorySnapshotError(`Git metadata path is not allowed: ${entry.path}`, "PATH_NOT_ALLOWED");
      if (entry.type !== "blob") throw new RepositorySnapshotError(`unsupported Git tree entry: ${entry.path}`, "UNSUPPORTED_ENTRY");
      if (!validateRelativeTreePath(entry.path)) throw new RepositorySnapshotError(`unsafe Git tree path: ${entry.path}`, "PATH_NOT_ALLOWED");
      if (entry.type !== "blob") continue;
      if (entry.mode === "120000") throw new RepositorySnapshotError(`symlink is not allowed: ${entry.path}`, "SYMLINK_NOT_ALLOWED");
      if (entry.mode !== "100644" && entry.mode !== "100755") {
        throw new RepositorySnapshotError(`unsupported Git entry mode for ${entry.path}`, "UNSUPPORTED_ENTRY");
      }
      for (const allowedPath of allowedPaths) {
        if (allowedPath === "." || entry.path === allowedPath || entry.path.startsWith(`${allowedPath}/`)) matchedPaths.add(allowedPath);
      }
    }
    for (const allowedPath of allowedPaths) {
      if (!matchedPaths.has(allowedPath)) {
        const direct = parseTreeEntries(await gitBuffer(this.repositoryRoot, ["ls-tree", "-z", "--full-tree", resolvedRevision, "--", allowedPath]));
        if (direct.some((entry) => entry.mode === "120000")) throw new RepositorySnapshotError(`symlink is not allowed: ${allowedPath}`, "SYMLINK_NOT_ALLOWED");
        if (direct.length === 0) throw new RepositorySnapshotError(`path is not present at pinned revision: ${allowedPath}`, "PATH_NOT_FOUND");
        throw new RepositorySnapshotError(`path does not contain a regular file: ${allowedPath}`, "UNSUPPORTED_ENTRY");
      }
    }

    const fileRecords: RepositorySnapshotFile[] = [];
    for (const entry of files.sort((left, right) => left.path.localeCompare(right.path))) {
      const content = await gitBuffer(this.repositoryRoot, ["cat-file", "blob", entry.objectId]);
      fileRecords.push({ path: entry.path, contentHash: sha256Bytes(content), byteLength: content.byteLength });
    }
    const fingerprint = sha256({ repositoryRevision: revision, files: fileRecords } as unknown as JsonValue);
    const snapshotWithoutHash = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      id: idFromHash("snapshot", fingerprint),
      incidentId: request.incidentId,
      correlationId: request.correlationId,
      createdAt,
      kind: "RepositorySnapshot" as const,
      repositoryRevision: revision,
      files: fileRecords,
      adapter: this.adapter,
    };
    const contentHash = sha256(snapshotWithoutHash as unknown as JsonValue);
    const snapshot: RepositorySnapshot = { ...snapshotWithoutHash, contentHash };

    let workspace = this.workspaces.get(snapshot.id);
    if (workspace === undefined) {
      workspace = await mkdtemp(join(this.snapshotRoot ?? tmpdir(), "rift-snapshot-"));
      try {
        for (const entry of files) {
          const content = await gitBuffer(this.repositoryRoot, ["cat-file", "blob", entry.objectId]);
          const target = resolve(workspace, entry.path);
          if (!isWithin(workspace, target)) throw new RepositorySnapshotError(`path escaped snapshot workspace: ${entry.path}`, "PATH_NOT_ALLOWED");
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, content, { mode: entry.mode === "100755" ? 0o755 : 0o644, flag: "wx" });
        }
        this.workspaces.set(snapshot.id, workspace);
      } catch (error) {
        await rm(workspace, { recursive: true, force: true });
        throw error;
      }
    }
    return snapshot;
  }

  public getSnapshotWorkspace(snapshotId: string): string | undefined {
    return this.workspaces.get(snapshotId);
  }

  public async dispose(snapshotId?: string): Promise<void> {
    const targets = snapshotId === undefined ? [...this.workspaces.entries()] : [[snapshotId, this.workspaces.get(snapshotId)] as const];
    for (const [id, workspace] of targets) {
      if (workspace !== undefined) await rm(workspace, { recursive: true, force: true });
      this.workspaces.delete(id);
    }
  }
}

function validateRelativeTreePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !/[\u0000-\u001f\u007f]/u.test(path) &&
    path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

export const GitRepositorySnapshotReader = RepositorySnapshotReaderAdapter;
export const RepositorySnapshotAdapter = RepositorySnapshotReaderAdapter;

export function repositoryFingerprint(snapshot: RepositorySnapshot): Sha256Hash {
  return sha256({ repositoryRevision: snapshot.repositoryRevision, files: snapshot.files } as unknown as JsonValue);
}
