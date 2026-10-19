import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cwd } from "node:process";
import { validateEvidenceItem, validateVerificationResult, type CandidatePatch, type EvidenceItem, type VerificationPlan } from "@rift/core";
import { DockerSandboxRunner, SpawnProcessRunner, type DockerSandboxRunnerOptions, type ProcessResult, type ProcessRunner } from "./docker-runner.js";
import { InMemoryEvidenceStore, LocalEvidenceStore } from "../domain/evidence-store.js";
import { computeEvidenceHash } from "../domain/hashing.js";
import { computeCandidatePatchContentHash } from "../investigation/candidate-patch-ranker.js";

const HASH = `sha256:${"a".repeat(64)}`;
const REVISION = { repository: "rift-demo", revision: "abcdef1" };
const EXPECTED_FAILURE = { code: "CHECKOUT_DISCOUNT", signature: "reproduced" };

function configured(process: ProcessRunner, options: Partial<DockerSandboxRunnerOptions> = {}): DockerSandboxRunnerOptions {
  return { image: "rift-runner:node20", docker: process, host: process, allowedCommands: ["npm"],
    evidenceStore: new InMemoryEvidenceStore(), expectedBaselineFailure: EXPECTED_FAILURE, ...options };
}

function request(verificationPlan = plan()) {
  return { repositoryPath: "/tmp/rift-fixture-checkout", candidatePatch: patch(), verificationPlan };
}

function output(stdout: string, exitCode: number | null = 1, rest: Partial<ProcessResult> = {}): ProcessResult {
  return { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), ...rest };
}

function patch(revision = REVISION): CandidatePatch {
  const withoutHash: Omit<CandidatePatch, "contentHash"> = {
    kind: "CandidatePatch",
    schemaVersion: 1,
    id: "patch-1",
    incidentId: "RIFT-042",
    correlationId: "run-1",
    createdAt: "2026-10-18T10:00:00.000Z",
    sourceHypothesisId: "hypothesis-1",
    baseRevision: revision,
    diff: "diff --git a/src/checkout.ts b/src/checkout.ts\n--- a/src/checkout.ts\n+++ b/src/checkout.ts\n@@ -1 +1 @@\n-old\n+new\n",
    touchedPaths: ["src/checkout.ts"],
    rationale: "Apply the discount once.",
    expectedInvariant: "The total is discounted exactly once.",
    generatedBy: { actor: "fake-model" },
  };
  return { ...withoutHash, contentHash: computeCandidatePatchContentHash(withoutHash) };
}

function plan(command = "npm", revision = REVISION): VerificationPlan {
  return {
    kind: "VerificationPlan",
    schemaVersion: 1,
    id: "plan-1",
    incidentId: "RIFT-042",
    correlationId: "run-1",
    createdAt: "2026-10-18T10:00:00.000Z",
    contentHash: HASH,
    candidatePatchId: "patch-1",
    baseRevision: revision,
    baselineCommand: { command, args: ["test"] },
    verificationCommands: [{ command: "npm", args: ["test"] }],
    timeoutMs: 5_000,
    networkAccess: "disabled",
  };
}

class FakeProcessRunner implements ProcessRunner {
  public readonly calls: Array<{ command: string; args: readonly string[] }> = [];
  private applicationRuns = 0;

  public constructor(private readonly verificationExitCode = 0, private readonly cleanupExitCode = 0, private readonly baselineResult?: ProcessResult) {}

  public async run(command: string, args: readonly string[]): Promise<ProcessResult> {
    this.calls.push({ command, args });
    if (command === "git") return { exitCode: 0, stdout: Buffer.from("synthetic archive"), stderr: Buffer.alloc(0) };
    if (args[0] === "create") return { exitCode: 0, stdout: Buffer.from("container-1\n"), stderr: Buffer.alloc(0) };
    if (args[0] === "rm") return { exitCode: this.cleanupExitCode, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    if (args[0] === "exec" && args.includes("npm")) {
      const baseline = this.applicationRuns === 0;
      this.applicationRuns += 1;
      if (baseline && this.baselineResult) return this.baselineResult;
      return { exitCode: baseline ? 1 : this.verificationExitCode, stdout: Buffer.from(baseline ? "reproduced" : "patched"), stderr: Buffer.alloc(0) };
    }
    return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
}

describe("DockerSandboxRunner", () => {
  it("runs baseline before one patch, disables network, hashes output, and removes the container", async () => {
    const process = new FakeProcessRunner();
    const store = new InMemoryEvidenceStore();
    const runner = new DockerSandboxRunner(configured(process, { evidenceStore: store }));

    const result = await runner.run({ repositoryPath: "/tmp/rift-fixture-checkout", candidatePatch: patch(), verificationPlan: plan() });

    expect(result.verificationResult.classification).toBe("verified");
    expect(result.baseline.exitCode).toBe(1);
    expect(result.verification[0].exitCode).toBe(0);
    expect(result.baseline.stdoutHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.environmentFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.cleanupSucceeded).toBe(true);
    expect(validateVerificationResult(result.verificationResult).ok).toBe(true);
    const { baselineEvidenceIds, patchedEvidenceIds, evidenceIds } = result.verificationResult;
    expect(baselineEvidenceIds).toHaveLength(1);
    expect(patchedEvidenceIds).toHaveLength(1);
    expect(baselineEvidenceIds?.some((id) => patchedEvidenceIds?.includes(id))).toBe(false);
    expect(evidenceIds).toEqual([...(baselineEvidenceIds ?? []), ...(patchedEvidenceIds ?? [])]);
    for (const id of evidenceIds) {
      const item = store.get(id)!;
      const { contentHash, ...withoutHash } = item;
      expect(validateEvidenceItem(item).ok).toBe(true);
      expect(contentHash).toBe(computeEvidenceHash(withoutHash));
      expect(item.incidentId).toBe("RIFT-042");
      expect(item.correlationId).toBe("run-1");
      expect(item.provenance.metadata).toMatchObject({ verificationPlanId: "plan-1", candidatePatchId: "patch-1", revision: "abcdef1", environmentFingerprint: result.environmentFingerprint });
    }
    expect(store.get(baselineEvidenceIds![0])?.content).toMatchObject({ phase: "baseline", failureCode: "CHECKOUT_DISCOUNT", status: "failed", exitCode: 1 });
    const create = process.calls.find((call) => call.args[0] === "create");
    expect(create?.args).toContain("--network");
    expect(create?.args).toContain("none");
    expect(process.calls.some((call) => call.args.some((arg) => ["-v", "--volume", "--mount", "--volumes-from"].includes(arg)))).toBe(false);
    const applyCalls = process.calls.filter((call) => call.args.includes("apply"));
    expect(applyCalls).toHaveLength(2);
    expect(applyCalls.filter((call) => !call.args.includes("--check"))).toHaveLength(1);
    expect(applyCalls.find((call) => !call.args.includes("--check"))?.args).toContain("/tmp/rift-candidate.patch");
    const baselineIndex = process.calls.findIndex((call) => call.args[0] === "exec" && call.args.includes("npm"));
    const patchIndex = process.calls.findIndex((call) => call.args.includes("apply"));
    expect(baselineIndex).toBeLessThan(patchIndex);
    expect(process.calls.some((call) => call.args[0] === "rm" && call.args[1] === "-f")).toBe(true);
  });

  it("fails closed when the baseline command is not allowlisted", async () => {
    const process = new FakeProcessRunner();
    const runner = new DockerSandboxRunner(configured(process));

    const result = await runner.run({ repositoryPath: "/tmp/rift-fixture-checkout", candidatePatch: patch(), verificationPlan: plan("curl") });

    expect(result.verificationResult.classification).toBe("inconclusive");
    expect(result.baseline.status).toBe("blocked");
    expect(process.calls.some((call) => call.args.includes("apply"))).toBe(false);
  });

  it("classifies a failing patched fixture as regressed and preserves host files", async () => {
    const process = new FakeProcessRunner(1);
    const repositoryPath = cwd();
    const before = await readFile(`${repositoryPath}/package.json`, "utf8");
    const runner = new DockerSandboxRunner(configured(process, { host: new SpawnProcessRunner(67_108_864) }));

    const hostRevision = { repository: "rift", revision: "6a7f984" };
    const result = await runner.run({ repositoryPath, candidatePatch: patch(hostRevision), verificationPlan: plan("npm", hostRevision) });

    const after = await readFile(`${repositoryPath}/package.json`, "utf8");
    expect(result.verificationResult.classification).toBe("regressed");
    expect(result.verificationResult.patchedExitCode).toBe(1);
    expect(after).toBe(before);
    expect(process.calls.some((call) => call.args.includes("-v") || call.args.includes("--volume"))).toBe(false);
  });

  it("fails closed when disposable cleanup fails", async () => {
    const process = new FakeProcessRunner(0, 1);
    const runner = new DockerSandboxRunner(configured(process));

    const result = await runner.run({ repositoryPath: "/tmp/rift-fixture-checkout", candidatePatch: patch(), verificationPlan: plan() });

    expect(result.cleanupSucceeded).toBe(false);
    expect(result.verificationResult.classification).toBe("inconclusive");
    expect(result.verificationResult.failure?.code).toBe("CLEANUP_FAILED");
  });

  it.each(["signature", "store", "both"])("fails closed without required %s capability", async (missing) => {
    const process = new FakeProcessRunner();
    const runner = new DockerSandboxRunner(configured(process, {
      ...(missing !== "store" ? { expectedBaselineFailure: undefined } : {}),
      ...(missing !== "signature" ? { evidenceStore: undefined } : {}),
    }));
    const result = await runner.run(request());
    expect(result.verificationResult.classification).toBe("inconclusive");
    expect(result.verificationResult.failure?.code).toBe("VERIFICATION_CAPABILITY_REQUIRED");
    expect(process.calls.some((call) => call.args.includes("apply"))).toBe(false);
    if (missing !== "signature") expect(result.verificationResult.evidenceIds).toEqual([]);
  });

  it.each([
    ["unrelated failure", output("unrelated failure"), "not-reproduced"],
    ["successful baseline", output("reproduced", 0), "not-reproduced"],
    ["timeout with matching partial output", output("reproduced", 1, { timedOut: true }), "inconclusive"],
    ["cancellation with matching partial output", output("reproduced", 1, { cancelled: true }), "inconclusive"],
    ["missing exit code", output("reproduced", null), "inconclusive"],
    ["invalid negative exit code", output("reproduced", -1), "not-reproduced"],
  ] as const)("never patches after %s", async (_label, baselineResult, classification) => {
    const process = new FakeProcessRunner(0, 0, baselineResult);
    const result = await new DockerSandboxRunner(configured(process)).run(request());
    expect(result.verificationResult.classification).toBe(classification);
    expect(result.verification).toEqual([]);
    expect(process.calls.some((call) => call.args.includes("apply"))).toBe(false);
  });

  it("requires the signature on the configured stream", async () => {
    const process = new FakeProcessRunner();
    const result = await new DockerSandboxRunner(configured(process, { expectedBaselineFailure: { ...EXPECTED_FAILURE, stream: "stderr" } })).run(request());
    expect(result.verificationResult.classification).toBe("not-reproduced");
    expect(process.calls.some((call) => call.args.includes("apply"))).toBe(false);
  });

  it("recognizes an actual nonzero baseline signature on stderr", async () => {
    const process = new FakeProcessRunner(0, 0, output("", 2, { stderr: Buffer.from("reproduced") }));
    const result = await new DockerSandboxRunner(configured(process, { expectedBaselineFailure: { ...EXPECTED_FAILURE, stream: "stderr" } })).run(request());
    expect(result.verificationResult.classification).toBe("verified");
    expect(result.verificationResult.baselineExitCode).toBe(2);
  });

  it.each(["throw", "drop", "alter"])("fails closed if evidence persistence will %s", async (behavior) => {
    const process = new FakeProcessRunner();
    const store = new InMemoryEvidenceStore();
    const append = store.append.bind(store);
    store.append = (item: EvidenceItem): EvidenceItem => {
      if (behavior === "throw") throw new Error("secret=do-not-leak");
      if (behavior === "drop") return item;
      const altered = { ...item, content: "altered" };
      return append(altered);
    };
    const result = await new DockerSandboxRunner(configured(process, { evidenceStore: store })).run(request());
    expect(result.verificationResult.classification).toBe("inconclusive");
    expect(result.verificationResult.evidenceIds).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("do-not-leak");
    expect(process.calls.some((call) => call.args.includes("apply"))).toBe(false);
  });

  it("requires successful persistence for patched captures too", async () => {
    const process = new FakeProcessRunner();
    const store = new InMemoryEvidenceStore();
    const append = store.append.bind(store);
    store.append = (item: EvidenceItem): EvidenceItem => {
      if (store.list().length) throw new Error("storage unavailable");
      return append(item);
    };
    const result = await new DockerSandboxRunner(configured(process, { evidenceStore: store })).run(request());
    expect(result.verificationResult.classification).toBe("inconclusive");
    expect(result.verificationResult.baselineEvidenceIds).toHaveLength(1);
    expect(result.verificationResult.patchedEvidenceIds).toEqual([]);
  });

  it("persists bounded, redacted captures with canonical hashes into the real store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rift-legacy-evidence-test-"));
    try {
      const filePath = join(directory, "evidence.jsonl");
      const store = new LocalEvidenceStore(filePath);
      const process = new FakeProcessRunner(0, 0, output(`reproduced\nBearer sensitive-bearer\napi_key=private-key-value\ncustom-private-value\nenv-private-value\n${"x".repeat(10_000)}`));
      const verificationPlan = { ...plan(), baselineCommand: { command: "npm", args: ["test"], environment: { API_TOKEN: "env-private-value" } } };
      const result = await new DockerSandboxRunner(configured(process, { evidenceStore: store, captureLimitBytes: 1024, redactValues: ["custom-private-value"] })).run(request(verificationPlan));
      expect(result.verificationResult.classification).toBe("verified");
      expect(result.baseline.stdoutTruncated).toBe(true);
      const reloaded = new LocalEvidenceStore(filePath);
      const item = reloaded.get(result.verificationResult.baselineEvidenceIds![0])!;
      const content = item.content as Record<string, string | number | boolean>;
      const stdout = Buffer.from(content.stdout as string, "base64");
      expect(stdout.length).toBeLessThanOrEqual(256);
      expect(stdout.toString()).toContain("reproduced\n");
      expect(stdout.toString()).toContain("[REDACTED]");
      for (const secret of ["sensitive-bearer", "private-key-value", "custom-private-value", "env-private-value"]) {
        expect(stdout.toString()).not.toContain(secret);
        expect(await readFile(filePath, "utf8")).not.toContain(secret);
      }
      expect(item.redaction.status).toBe("redacted");
      expect(content.stdoutHash).toBe(`sha256:${createHash("sha256").update(stdout).digest("hex")}`);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("cannot match a signature outside retained output or one removed by redaction", async () => {
    for (const baselineResult of [output(`${"x".repeat(300)}reproduced`), output("reproduced")]) {
      const process = new FakeProcessRunner(0, 0, baselineResult);
      const result = await new DockerSandboxRunner(configured(process, { captureLimitBytes: 1024, redactValues: ["reproduced"] })).run(request());
      expect(result.verificationResult.classification).toBe("not-reproduced");
      expect(process.calls.some((call) => call.args.includes("apply"))).toBe(false);
    }
  });

  it("redacts configured secrets and private keys cut off by the capture boundary", async () => {
    const secret = "configured-private-value";
    for (const text of [`${"x".repeat(244)}${secret}`, `reproduced\n-----BEGIN PRIVATE KEY-----\n${"private-material".repeat(100)}`]) {
      const process = new FakeProcessRunner(0, 0, output(text));
      const store = new InMemoryEvidenceStore();
      await new DockerSandboxRunner(configured(process, { evidenceStore: store, captureLimitBytes: 1024, redactValues: [secret] })).run(request());
      const item = store.list()[0];
      const stdout = Buffer.from((item.content as Record<string, string>).stdout, "base64").toString();
      expect(stdout).not.toContain("configured-p");
      expect(stdout).not.toContain("private-material");
      expect(item.redaction.status).toBe("redacted");
    }
  });

  it("respects retained byte limits across a multibyte UTF-8 boundary", async () => {
    const process = new FakeProcessRunner(0, 0, output(`reproduced${"€".repeat(1000)}`));
    const store = new InMemoryEvidenceStore();
    const result = await new DockerSandboxRunner(configured(process, { evidenceStore: store, captureLimitBytes: 1028 })).run(request());
    const content = store.get(result.verificationResult.baselineEvidenceIds![0])!.content as Record<string, string>;
    expect(Buffer.from(content.stdout, "base64").length).toBeLessThanOrEqual(257);
  });

  it("does not fabricate success for an empty patched command list", async () => {
    const result = await new DockerSandboxRunner(configured(new FakeProcessRunner())).run(request({ ...plan(), verificationCommands: [] }));
    expect(result.verificationResult.classification).toBe("regressed");
    expect(result.verificationResult.patchedEvidenceIds).toEqual([]);
  });

  it("rejects a mismatched incident context before any process runs", async () => {
    const process = new FakeProcessRunner();
    await expect(new DockerSandboxRunner(configured(process)).run(request({ ...plan(), correlationId: "another-run" }))).rejects.toThrow("different incident contexts");
    expect(process.calls).toEqual([]);
  });

  it("rejects a tampered candidate patch before reading the repository", async () => {
    const process = new FakeProcessRunner();
    const input = request();
    await expect(new DockerSandboxRunner(configured(process)).run({ ...input, candidatePatch: { ...input.candidatePatch, rationale: "tampered" } })).rejects.toThrow("content hash");
    expect(process.calls).toEqual([]);
  });

  it("redacts command environment values in returned captures", async () => {
    const process = new FakeProcessRunner();
    const verificationPlan = { ...plan(), baselineCommand: { ...plan().baselineCommand, environment: { API_TOKEN: "secret-token", SAFE_FLAG: "true" } } };
    const result = await new DockerSandboxRunner(configured(process)).run(request(verificationPlan));
    expect(result.baseline.command.environment).toEqual({ API_TOKEN: "[REDACTED]", SAFE_FLAG: "[REDACTED]" });
    expect(JSON.stringify(result.baseline)).not.toContain("secret-token");
  });
});

describe("SpawnProcessRunner", () => {
  it("bounds retained output while draining both streams and recording their full sizes", async () => {
    const result = await new SpawnProcessRunner(64).run(globalThis.process.execPath, ["-e", "process.stdout.write('a'.repeat(10000)); process.stderr.write('b'.repeat(20000))"], { timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBe(64);
    expect(result.stderr.length).toBe(64);
    expect(result.stdoutBytes).toBe(10000);
    expect(result.stderrBytes).toBe(20000);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
  });

  it("does not execute an already cancelled command", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await new SpawnProcessRunner().run("does-not-exist", [], { signal: controller.signal });
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it("never exposes timeout as a completed nonzero command", async () => {
    const result = await new SpawnProcessRunner().run(globalThis.process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 50 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });
});
