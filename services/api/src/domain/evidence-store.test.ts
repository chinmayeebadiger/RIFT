import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EvidenceItem } from "./contracts.js";
import { EvidenceStoreError, InMemoryEvidenceStore, LocalEvidenceStore } from "./evidence-store.js";
import { withEvidenceHash } from "./hashing.js";

function evidence(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    schemaVersion: 1,
    kind: "EvidenceItem",
    id: "evidence-1",
    incidentId: "incident-1",
    correlationId: "run-1",
    createdAt: "2026-10-18T10:00:00.000Z",
    capturedAt: "2026-10-18T10:00:01.000Z",
    contentHash: "sha256:abc123",
    content: { message: "synthetic failure" },
    source: { type: "log", locator: "fixture.log" },
    redaction: { status: "not-required" },
    provenance: { actor: "test", tool: "fixture-loader" },
    ...overrides,
  };
}

function validEvidence(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  const { contentHash: _contentHash, ...withoutHash } = evidence(overrides);
  return withEvidenceHash(withoutHash);
}

describe("InMemoryEvidenceStore", () => {
  it("preserves append order and supports incident/source queries", () => {
    const store = new InMemoryEvidenceStore();
    store.append(evidence());
    store.append(
      evidence({
        id: "evidence-2",
        incidentId: "incident-2",
        source: { type: "stack-trace", locator: "trace.txt" },
      }),
    );

    expect(store.list().map((item) => item.id)).toEqual(["evidence-1", "evidence-2"]);
    expect(store.list({ incidentId: "incident-2" }).map((item) => item.id)).toEqual(["evidence-2"]);
    expect(store.list({ sourceType: "log" }).map((item) => item.id)).toEqual(["evidence-1"]);
  });

  it("rejects duplicate ids and protects stored items from caller mutation", () => {
    const store = new InMemoryEvidenceStore();
    const item = evidence();
    store.append(item);

    const returned = store.get(item.id);
    expect(returned).toBeDefined();
    if (returned !== undefined && typeof returned.content === "object" && returned.content !== null) {
      (returned.content as { message: string }).message = "mutated outside the store";
    }

    expect(store.get(item.id)?.content).toEqual({ message: "synthetic failure" });
    expect(() => store.append(item)).toThrow(`Evidence item already exists: ${item.id}`);
  });
});

describe("LocalEvidenceStore", () => {
  function withStore(run: (path: string) => void): void {
    const directory = mkdtempSync(join(tmpdir(), "rift-evidence-test-"));
    try {
      run(join(directory, "evidence.jsonl"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it("persists deterministic append order and reopens without changing reads", () => {
    withStore((path) => {
      const first = validEvidence();
      const second = validEvidence({ id: "evidence-2", capturedAt: "2026-10-18T10:00:02.000Z" });
      const store = new LocalEvidenceStore(path);
      store.append(first);
      store.append(second);

      expect(new LocalEvidenceStore(path).list()).toEqual([first, second]);
      expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
    });
  });

  it("makes an identical retry idempotent but rejects a changed duplicate", () => {
    withStore((path) => {
      const item = validEvidence();
      const store = new LocalEvidenceStore(path);
      expect(store.append(item)).toEqual(item);
      expect(() => store.append({ ...item, content: { message: "same hash input changed" } })).toThrowError(
        /content hash does not match/,
      );
      expect(new LocalEvidenceStore(path).list()).toEqual([item]);
    });
  });

  it("rejects a duplicate id with different content and mismatched hashes", () => {
    withStore((path) => {
      const item = validEvidence();
      const store = new LocalEvidenceStore(path);
      store.append(item);

      const changed = validEvidence({ content: { message: "different" } });
      expect(() => store.append(changed)).toThrowError(EvidenceStoreError);
      expect(() => store.append({ ...item, contentHash: "sha256:" + "0".repeat(64) })).toThrowError(
        /content hash does not match/,
      );
      expect(store.list()).toHaveLength(1);
    });
  });

  it("keeps persisted evidence immutable at the read boundary", () => {
    withStore((path) => {
      const item = validEvidence();
      const store = new LocalEvidenceStore(path);
      store.append(item);
      const returned = store.get(item.id);
      expect(returned).toBeDefined();
      if (returned !== undefined && typeof returned.content === "object" && returned.content !== null) {
        (returned.content as { message: string }).message = "mutated";
      }

      expect(new LocalEvidenceStore(path).get(item.id)?.content).toEqual(item.content);
    });
  });

  it("fails closed for corrupt records instead of dropping them", () => {
    withStore((path) => {
      writeFileSync(path, '{"id":"truncated"}\nnot-json\n', "utf8");
      expect(() => new LocalEvidenceStore(path)).toThrowError(/line 1|line 2/);
    });
  });
});
