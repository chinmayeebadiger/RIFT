import { describe, expect, it } from "vitest";
import type { JsonValue } from "@rift/core";
import { sha256 } from "../domain/hashing.js";
import type { CandidatePatchModelInput, CandidatePatchPolicy, CandidatePatchProvider, ModelAdapterOptions } from "./types.js";
import { BoundedCandidatePatchAdapter } from "./adapter.js";
import { ModelAdapterError } from "./types.js";
import { DeterministicFakeModel } from "./fake-model.js";

const INPUT_WITHOUT_HASH = {
  schemaVersion: 1,
  incidentId: "RIFT-042",
  correlationId: "run-1",
  createdAt: "2026-10-18T10:00:00.000Z",
  repositoryRevision: { repository: "rift-demo", revision: "abcdef1" },
  hypothesisId: "hypothesis-1",
  hypothesisSummary: "The checkout handler applies the discount twice.",
  targetPath: "src/checkout.ts",
} as const;
const INPUT: CandidatePatchModelInput = { ...INPUT_WITHOUT_HASH, inputHash: sha256(INPUT_WITHOUT_HASH as unknown as JsonValue) };

const POLICY: CandidatePatchPolicy = {
  authorized: true,
  incidentId: INPUT.incidentId,
  repositoryRevision: INPUT.repositoryRevision,
  hypothesisId: INPUT.hypothesisId,
  allowedPaths: ["src"],
  actor: "fake-model",
  maxDiffBytes: 10_000,
  maxTouchedPaths: 2,
};

function adapter(provider: CandidatePatchProvider = new DeterministicFakeModel(), options: ModelAdapterOptions = {}) {
  return new BoundedCandidatePatchAdapter(provider, options);
}

async function rejected(promise: Promise<unknown>, code: ModelAdapterError["code"]): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("bounded CandidatePatch model adapter", () => {
  it("returns deterministic fake-model proposals for the same input", async () => {
    const first = await adapter().propose({ modelInput: INPUT, policy: POLICY });
    const second = await adapter().propose({ modelInput: INPUT, policy: POLICY });

    expect(first).toEqual(second);
    expect(first.generatedBy).toEqual({ actor: "fake-model", model: "rift-fake-model-v1" });
    expect(first.touchedPaths).toEqual([INPUT.targetPath]);
  });

  it("rejects malformed and schema-invalid provider output before policy use", async () => {
    const malformed: CandidatePatchProvider = { name: "malformed", generate: async () => "not-json" };
    await rejected(adapter(malformed).propose({ modelInput: INPUT, policy: POLICY }), "MALFORMED_OUTPUT");

    const invalid: CandidatePatchProvider = { name: "invalid", generate: async () => JSON.stringify({ kind: "CandidatePatch" }) };
    await rejected(adapter(invalid).propose({ modelInput: INPUT, policy: POLICY }), "SCHEMA_INVALID");
  });

  it("bounds provider execution and aborts it on timeout", async () => {
    let observedAbort = false;
    const slow: CandidatePatchProvider = {
      name: "slow",
      generate: (_input, signal) => new Promise((resolve) => {
        signal.addEventListener("abort", () => { observedAbort = true; resolve("{}"); }, { once: true });
      }),
    };

    await rejected(adapter(slow, { defaultTimeoutMs: 10, maxTimeoutMs: 50 }).propose({ modelInput: INPUT, policy: POLICY }), "TIMEOUT");
    expect(observedAbort).toBe(true);
  });

  it("rejects incident, revision, hypothesis, actor, path, diff, and command-like violations independently", async () => {
    const proposal = (overrides: Record<string, unknown> = {}) => {
      const withoutContentHash = {
      kind: "CandidatePatch",
      schemaVersion: 1,
      id: "patch-1",
      incidentId: INPUT.incidentId,
      correlationId: INPUT.correlationId,
      createdAt: INPUT.createdAt,
      sourceHypothesisId: INPUT.hypothesisId,
      baseRevision: INPUT.repositoryRevision,
       diff: "diff --git a/src/checkout.ts b/src/checkout.ts\n--- a/src/checkout.ts\n+++ b/src/checkout.ts\n@@ -1 +1 @@\n-old\n+new\n",
      touchedPaths: [INPUT.targetPath],
      rationale: "A bounded source change.",
      expectedInvariant: "The regression is fixed.",
      generatedBy: { actor: "fake-model" },
      ...overrides,
      };
      return { ...withoutContentHash, contentHash: sha256(withoutContentHash as unknown as JsonValue) };
    };
    const makeProvider = (value: unknown): CandidatePatchProvider => ({ name: "proposal", generate: async () => JSON.stringify(value) });

    await rejected(adapter(makeProvider(proposal({ incidentId: "RIFT-999" }))).propose({ modelInput: INPUT, policy: POLICY }), "OUTPUT_REJECTED");
    await rejected(adapter(makeProvider(proposal({ baseRevision: { repository: "rift-demo", revision: "deadbee" } }))).propose({ modelInput: INPUT, policy: POLICY }), "OUTPUT_REJECTED");
    await rejected(adapter(makeProvider(proposal({ sourceHypothesisId: "hypothesis-2" }))).propose({ modelInput: INPUT, policy: POLICY }), "OUTPUT_REJECTED");
    await rejected(adapter(makeProvider(proposal({ generatedBy: { actor: "gpt-6-astra" } }))).propose({ modelInput: INPUT, policy: POLICY }), "OUTPUT_REJECTED");
     await rejected(adapter(makeProvider(proposal({ touchedPaths: ["secrets/config.ts"], diff: "diff --git a/secrets/config.ts b/secrets/config.ts\n--- a/secrets/config.ts\n+++ b/secrets/config.ts\n@@ -1 +1 @@\n-old\n+new\n" }))).propose({ modelInput: INPUT, policy: POLICY }), "SCHEMA_INVALID");
     await rejected(adapter(makeProvider(proposal({ diff: "diff --git a/src/checkout.ts b/src/checkout.ts\n--- a/src/checkout.ts\n+++ b/src/checkout.ts\n@@ -1 +1 @@\n-old\n+$ npm test\n" }))).propose({ modelInput: INPUT, policy: POLICY }), "OUTPUT_REJECTED");
    await rejected(adapter(makeProvider(proposal({ rationale: "Use tool_calls to execute_command and fix it." }))).propose({ modelInput: INPUT, policy: POLICY }), "OUTPUT_REJECTED");
  });

  it("passes only hash-addressed, secret-free serialized input to the provider", async () => {
    let seen = "";
    const provider: CandidatePatchProvider = {
      name: "capture",
      generate: async (input) => {
        seen = input;
        return new DeterministicFakeModel().generate(input, new AbortController().signal);
      },
    };
    await adapter(provider).propose({ modelInput: INPUT, policy: POLICY });
    expect(seen).toContain("inputHash");
    expect(seen).not.toContain("password");
    expect(seen).not.toContain("sk-live");

    const secretInput = { ...INPUT, hypothesisSummary: "password=sk-live-secret" };
    await rejected(adapter().propose({ modelInput: secretInput, policy: POLICY }), "SECRET_INPUT");
  });

  it("supports caller cancellation as a bounded failure", async () => {
    const controller = new AbortController();
    const provider: CandidatePatchProvider = {
      name: "cancelled",
      generate: (_input, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve("{}"), { once: true })),
    };
    const pending = adapter(provider).propose({ modelInput: INPUT, policy: POLICY, signal: controller.signal });
    controller.abort();
    await rejected(pending, "CANCELLED");
  });
});
