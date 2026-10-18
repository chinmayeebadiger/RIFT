import type { EvidenceItem } from "./contracts.js";

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
