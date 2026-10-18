import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import type { EvidenceItem, JsonValue } from "./contracts.js";
import { canonicalJson, computeEvidenceHash } from "./hashing.js";
import { redactEvidenceForModel } from "./redaction.js";
import { validateEvidenceItem } from "./validators.js";

export interface EvidenceQuery {
  readonly incidentId?: string;
  readonly correlationId?: string;
  readonly sourceType?: string;
}

/**
 * Append-only evidence persistence boundary.
 *
 * Implementations must not update or remove an item. `append` rejects a
 * duplicate id so retries cannot silently replace an earlier observation.
 */
export interface EvidenceStore {
  append(item: EvidenceItem): EvidenceItem;
  get(id: string): EvidenceItem | undefined;
  list(query?: EvidenceQuery): readonly EvidenceItem[];
}

export class EvidenceStoreError extends Error {
  public constructor(
    message: string,
    public readonly code:
      | "EVIDENCE_STORE_INVALID"
      | "EVIDENCE_STORE_CORRUPT"
      | "EVIDENCE_STORE_DUPLICATE"
      | "EVIDENCE_STORE_IO",
  ) {
    super(message);
    this.name = "EvidenceStoreError";
  }
}

function clone<T>(value: T): T {
  // Domain values are JSON-compatible by contract. Cloning at the boundary
  // keeps callers from mutating data that the store considers immutable.
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Deterministic, dependency-free store for unit tests and local workflows. */
export class InMemoryEvidenceStore implements EvidenceStore {
  private readonly items: EvidenceItem[] = [];

  public constructor(initialItems: readonly EvidenceItem[] = []) {
    for (const item of initialItems) {
      this.append(item);
    }
  }

  public append(item: EvidenceItem): EvidenceItem {
    if (this.items.some((existing) => existing.id === item.id)) {
      throw new Error(`Evidence item already exists: ${item.id}`);
    }

    const stored = clone(item);
    this.items.push(stored);
    return clone(stored);
  }

  public get(id: string): EvidenceItem | undefined {
    const item = this.items.find((candidate) => candidate.id === id);
    return item === undefined ? undefined : clone(item);
  }

  public list(query: EvidenceQuery = {}): readonly EvidenceItem[] {
    return this.items
      .filter((item) => {
        if (query.incidentId !== undefined && item.incidentId !== query.incidentId) {
          return false;
        }
        if (query.correlationId !== undefined && item.correlationId !== query.correlationId) {
          return false;
        }
        if (query.sourceType !== undefined && item.source.type !== query.sourceType) {
          return false;
        }
        return true;
      })
      .map((item) => clone(item));
  }
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function matches(item: EvidenceItem, query: EvidenceQuery): boolean {
  return (
    (query.incidentId === undefined || item.incidentId === query.incidentId) &&
    (query.correlationId === undefined || item.correlationId === query.correlationId) &&
    (query.sourceType === undefined || item.source.type === query.sourceType)
  );
}

/**
 * Durable local JSONL evidence store. Each successful append is one immutable
 * line; startup validates every line and refuses to serve a partially corrupt
 * store rather than silently dropping evidence.
 */
export class LocalEvidenceStore implements EvidenceStore {
  private readonly items: EvidenceItem[] = [];
  private readonly byId = new Map<string, EvidenceItem>();
  private readonly byHash = new Map<string, EvidenceItem>();

  public constructor(public readonly filePath: string) {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      if (!existsSync(filePath)) appendFileSync(filePath, "", { encoding: "utf8" });
      this.load();
    } catch (error) {
      if (error instanceof EvidenceStoreError) throw error;
      throw new EvidenceStoreError(
        `Unable to open evidence store: ${error instanceof Error ? error.message : "unknown error"}`,
        "EVIDENCE_STORE_IO",
      );
    }
  }

  public append(item: EvidenceItem): EvidenceItem {
    this.validate(item);

    const existingById = this.byId.get(item.id);
    if (existingById !== undefined) {
      if (sameJson(existingById as unknown as JsonValue, item as unknown as JsonValue)) return cloneJson(existingById);
      throw new EvidenceStoreError(`Evidence item already exists: ${item.id}`, "EVIDENCE_STORE_DUPLICATE");
    }

    const existingByHash = this.byHash.get(item.contentHash);
    if (existingByHash !== undefined) {
      if (sameJson(existingByHash as unknown as JsonValue, item as unknown as JsonValue)) return cloneJson(existingByHash);
      throw new EvidenceStoreError(
        `Content hash already exists with different evidence: ${item.contentHash}`,
        "EVIDENCE_STORE_DUPLICATE",
      );
    }

    const stored = cloneJson(item);
    const line = `${JSON.stringify(stored)}\n`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(this.filePath, "a");
      const buffer = Buffer.from(line, "utf8");
      let offset = 0;
      while (offset < buffer.byteLength) offset += requireWrite(descriptor, buffer, offset);
      fsyncSync(descriptor);
    } catch (error) {
      throw new EvidenceStoreError(
        `Unable to append evidence: ${error instanceof Error ? error.message : "unknown error"}`,
        "EVIDENCE_STORE_IO",
      );
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }

    this.items.push(stored);
    this.byId.set(stored.id, stored);
    this.byHash.set(stored.contentHash, stored);
    return cloneJson(stored);
  }

  public get(id: string): EvidenceItem | undefined {
    const item = this.byId.get(id);
    return item === undefined ? undefined : cloneJson(item);
  }

  public list(query: EvidenceQuery = {}): readonly EvidenceItem[] {
    return this.items.filter((item) => matches(item, query)).map((item) => cloneJson(item));
  }

  /** Read only redaction-safe evidence for a future model call. */
  public getForModel(id: string): EvidenceItem | undefined {
    const item = this.byId.get(id);
    return item === undefined ? undefined : redactEvidenceForModel(cloneJson(item));
  }

  public listForModel(query: EvidenceQuery = {}): readonly EvidenceItem[] {
    return this.items
      .filter((item) => matches(item, query))
      .map((item) => redactEvidenceForModel(cloneJson(item)));
  }

  private validate(item: EvidenceItem): void {
    const result = validateEvidenceItem(item);
    if (!result.ok) {
      throw new EvidenceStoreError(
        `Evidence item failed validation: ${result.issues.map((issue) => `${issue.path}:${issue.code}`).join(",")}`,
        "EVIDENCE_STORE_INVALID",
      );
    }

    const { contentHash: _providedHash, ...withoutHash } = item;
    const expectedHash = computeEvidenceHash(withoutHash);
    if (item.contentHash !== expectedHash) {
      throw new EvidenceStoreError(
        `Evidence content hash does not match payload: ${item.id}`,
        "EVIDENCE_STORE_INVALID",
      );
    }
  }

  private load(): void {
    const contents = readFileSync(this.filePath, "utf8");
    const lines = contents.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new EvidenceStoreError(`Evidence store line ${index + 1} is not valid JSON`, "EVIDENCE_STORE_CORRUPT");
      }
      try {
        this.appendLoaded(parsed);
      } catch (error) {
        if (error instanceof EvidenceStoreError) {
          throw new EvidenceStoreError(`Evidence store line ${index + 1}: ${error.message}`, "EVIDENCE_STORE_CORRUPT");
        }
        throw error;
      }
    }
  }

  private appendLoaded(value: unknown): void {
    const result = validateEvidenceItem(value);
    if (!result.ok) throw new EvidenceStoreError("record failed contract validation", "EVIDENCE_STORE_INVALID");
    const item = result.value;
    this.validate(item);
    if (this.byId.has(item.id) || this.byHash.has(item.contentHash)) {
      throw new EvidenceStoreError("duplicate record", "EVIDENCE_STORE_DUPLICATE");
    }
    const stored = cloneJson(item);
    this.items.push(stored);
    this.byId.set(stored.id, stored);
    this.byHash.set(stored.contentHash, stored);
  }
}

function requireWrite(descriptor: number, buffer: Buffer, offset: number): number {
  const written = writeSync(descriptor, buffer, offset);
  if (written <= 0) throw new Error("Evidence store write made no progress");
  return written;
}

export const FileEvidenceStore = LocalEvidenceStore;
export const AppendOnlyEvidenceStore = LocalEvidenceStore;
