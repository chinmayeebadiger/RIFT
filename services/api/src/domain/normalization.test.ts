import { describe, expect, it } from "vitest";
import type { EvidenceItem } from "./contracts.js";
import { withEvidenceHash } from "./hashing.js";
import {
  buildDeterministicTimeline,
  citeEvidence,
  extractFailureSignature,
  normalizeLogEvidence,
  normalizeStackTraceEvidence,
  normalizeTimestamp,
} from "./normalization.js";

function evidence(id: string, content: string, locator = `${id}.log`): EvidenceItem {
  return withEvidenceHash({
    schemaVersion: 1,
    kind: "EvidenceItem",
    id,
    incidentId: "RIFT-NORMALIZATION-TEST",
    correlationId: "normalization-test-run",
    createdAt: "2026-10-18T12:00:00.000Z",
    capturedAt: "2026-10-18T12:00:00.000Z",
    content,
    source: { type: "application-log", locator },
    redaction: { status: "not-required" },
    provenance: { actor: "normalization-test" },
  });
}

describe("normalizeTimestamp", () => {
  it("normalizes fractional seconds, offsets, and a UTC date rollover", () => {
    expect(normalizeTimestamp("2026-10-18T09:59:41Z")).toEqual({
      state: "valid",
      value: "2026-10-18T09:59:41.000Z",
      raw: "2026-10-18T09:59:41Z",
    });
    expect(normalizeTimestamp("2026-10-18T09:59:41.2+05:30").value).toBe("2026-10-18T04:29:41.200Z");
    expect(normalizeTimestamp("2026-10-18T23:59:59.999-00:30").value).toBe("2026-10-19T00:29:59.999Z");
  });

  it("distinguishes missing timestamps from invalid timestamp values", () => {
    expect(normalizeTimestamp(undefined)).toEqual({ state: "missing" });
    expect(normalizeTimestamp("2026-02-30T10:00:00.000Z")).toEqual({
      state: "invalid",
      raw: "2026-02-30T10:00:00.000Z",
    });
    expect(normalizeTimestamp("2026-10-18T10:00:60.000Z").state).toBe("invalid");
    expect(normalizeTimestamp("2026-10-18T10:00:00.000").state).toBe("invalid");
    expect(normalizeTimestamp("2026-10-18T10:00:00.1234Z").state).toBe("invalid");
  });
});

describe("log and stack-trace normalization", () => {
  it("normalizes the M1 log, preserves Unicode, and extracts a cited signature", () => {
    const item = evidence(
      "checkout-log",
      [
        "2026-10-18T09:59:41.000Z level=warn request_id=fixture-request-001 route=/checkout status=503",
        "2026-10-18T09:59:41.001Z level=error signature=CHECKOUT_RETRY_POOL_EXHAUSTED message=\"checkout retry budget exhausted\"",
        "2026-10-18T09:59:41.002Z level=info 原因=\"支付失败 — पुनः प्रयास\" message=\"支付失败 — पुनः प्रयास\"",
      ].join("\n"),
      "logs/checkout-api.log",
    );

    const normalized = normalizeLogEvidence(item);
    expect(normalized.lines[0]?.fields).toEqual({
      level: "warn",
      request_id: "fixture-request-001",
      route: "/checkout",
      status: "503",
    });
    expect(normalized.lines[2]?.text).toContain("支付失败 — पुनः प्रयास");
    expect(normalized.lines[2]?.fields["原因"]).toBe("支付失败 — पुनः प्रयास");
    expect(normalized.diagnostics).toEqual([]);

    const signature = extractFailureSignature(normalized);
    expect(signature).toEqual({
      name: "CHECKOUT_RETRY_POOL_EXHAUSTED",
      status: 503,
      message: "checkout retry budget exhausted",
      citations: [{
        evidenceId: item.id,
        contentHash: item.contentHash,
        source: item.source,
        lineStart: 1,
        lineEnd: 2,
      }],
    });
  });

  it("keeps invalid and missing timestamps citeable across all line endings", () => {
    const item = evidence(
      "boundary-log",
      "2026-02-30T10:00:00.000Z level=error\r\nmessage=missing\r2026-10-18T10:00:60.000Z level=warn\n",
    );
    const normalized = normalizeLogEvidence(item);
    expect(normalized.lines.map(({ lineNumber, timestampState, timestamp }) => ({ lineNumber, timestampState, timestamp }))).toEqual([
      { lineNumber: 1, timestampState: "invalid", timestamp: undefined },
      { lineNumber: 2, timestampState: "missing", timestamp: undefined },
      { lineNumber: 3, timestampState: "invalid", timestamp: undefined },
    ]);
    expect(normalized.diagnostics).toEqual([
      { code: "invalid_timestamp", lineNumber: 1 },
      { code: "missing_timestamp", lineNumber: 2 },
      { code: "invalid_timestamp", lineNumber: 3 },
    ]);
    expect(normalized.lines[1]?.citation).toEqual(citeEvidence(item, 2));
  });

  it("handles a huge line without truncation or parser failure", () => {
    const hugeLine = `2026-10-18T10:00:00.000Z level=error message="${"界".repeat(250_000)}"`;
    const normalized = normalizeLogEvidence(evidence("huge-log", hugeLine));
    expect(normalized.lines).toHaveLength(1);
    expect(normalized.lines[0]?.raw).toBe(hugeLine);
    expect(normalized.lines[0]?.fields.message).toBe("界".repeat(250_000));
  });

  it("normalizes JavaScript stack frames while preserving malformed frame lines", () => {
    const item = evidence(
      "stack-trace",
      [
        "CheckoutError: retry pool exhausted",
        "    at retryCheckout (src/checkout.ts:12:4)",
        "    at src/checkout.ts:not-a-location",
        "    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
      ].join("\n"),
      "logs/checkout.stack",
    );
    const normalized = normalizeStackTraceEvidence(item);
    expect(normalized.frames).toEqual({
      2: { functionName: "retryCheckout", file: "src/checkout.ts", line: 12, column: 4 },
      4: { functionName: "processTicksAndRejections", file: "node:internal/process/task_queues", line: 95, column: 5 },
    });
    expect(normalized.diagnostics).toContainEqual({ code: "missing_timestamp", lineNumber: 1 });
    expect(normalized.diagnostics).toContainEqual({ code: "malformed_stack_frame", lineNumber: 3 });
    expect(extractFailureSignature(normalized)).toMatchObject({
      name: "CheckoutError",
      message: "retry pool exhausted",
      citations: [{ evidenceId: item.id, lineStart: 1, lineEnd: 1 }],
    });
  });
});

describe("buildDeterministicTimeline", () => {
  it("sorts by UTC time, then stable evidence identity, and puts unknown time last", () => {
    const first = normalizeLogEvidence(evidence(
      "evidence-b",
      [
        "2026-10-18T10:00:00.000Z level=info message=second",
        "message=unknown-b",
      ].join("\n"),
      "logs/b.log",
    ));
    const second = normalizeLogEvidence(evidence(
      "evidence-a",
      [
        "2026-10-18T10:00:00.000Z level=info message=first",
        "message=unknown-a",
      ].join("\n"),
      "logs/a.log",
    ));

    const forward = buildDeterministicTimeline([first, second]);
    const reversed = buildDeterministicTimeline([second, first]);
    expect(reversed).toEqual(forward);
    expect(forward.map((entry) => `${entry.sourceEvidenceId}:${entry.lineNumber}`)).toEqual([
      "evidence-a:1",
      "evidence-b:1",
      "evidence-a:2",
      "evidence-b:2",
    ]);
    expect(forward[2]?.timestamp).toBeNull();
    expect(forward[2]?.timestampState).toBe("missing");
    expect(forward.every((entry) => entry.citations[0]?.evidenceId === entry.sourceEvidenceId)).toBe(true);
  });

  it("does not coerce an unknown timestamp to capturedAt", () => {
    const item = evidence("unknown-time", "message=not timed");
    const [entry] = buildDeterministicTimeline([normalizeLogEvidence(item)]);
    expect(entry).toMatchObject({
      timestamp: null,
      timestampState: "missing",
      detail: "message=not timed",
    });
    expect(entry?.timestamp).not.toBe(item.capturedAt);
  });
});
