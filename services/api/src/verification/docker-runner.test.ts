import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { cwd } from "node:process";
import type { CandidatePatch, VerificationPlan } from "@rift/core";
import { DockerSandboxRunner, SpawnProcessRunner, type ProcessResult, type ProcessRunner } from "./docker-runner.js";

const HASH = `sha256:${"a".repeat(64)}`;
const REVISION = { repository: "rift-demo", revision: "abcdef1" };

function patch(revision = REVISION): CandidatePatch {
  return {
    kind: "CandidatePatch",
    schemaVersion: 1,
    id: "patch-1",
    incidentId: "RIFT-042",
    correlationId: "run-1",
    createdAt: "2026-10-18T10:00:00.000Z",
    contentHash: HASH,
    sourceHypothesisId: "hypothesis-1",
    baseRevision: revision,
    diff: "diff --git a/src/checkout.ts b/src/checkout.ts",
    touchedPaths: ["src/checkout.ts"],
    rationale: "Apply the discount once.",
    expectedInvariant: "The total is discounted exactly once.",
    generatedBy: { actor: "fake-model" },
  };
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

  public constructor(private readonly verificationExitCode = 0, private readonly cleanupExitCode = 0) {}

  public async run(command: string, args: readonly string[]): Promise<ProcessResult> {
    this.calls.push({ command, args });
    if (command === "git") return { exitCode: 0, stdout: Buffer.from("synthetic archive"), stderr: Buffer.alloc(0) };
    if (args[0] === "create") return { exitCode: 0, stdout: Buffer.from("container-1\n"), stderr: Buffer.alloc(0) };
    if (args[0] === "rm") return { exitCode: this.cleanupExitCode, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    if (args[0] === "exec" && args.includes("npm")) {
      const baseline = this.applicationRuns === 0;
      this.applicationRuns += 1;
      return { exitCode: baseline ? 1 : this.verificationExitCode, stdout: Buffer.from(baseline ? "reproduced" : "patched"), stderr: Buffer.alloc(0) };
    }
    return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
}

describe("DockerSandboxRunner", () => {
  it("runs baseline before one patch, disables network, hashes output, and removes the container", async () => {
    const process = new FakeProcessRunner();
    const runner = new DockerSandboxRunner({
      image: "rift-runner:node20",
      docker: process,
      host: process,
      allowedCommands: ["npm"],
    });

    const result = await runner.run({ repositoryPath: "/tmp/rift-fixture-checkout", candidatePatch: patch(), verificationPlan: plan() });

    expect(result.verificationResult.classification).toBe("verified");
    expect(result.baseline.exitCode).toBe(1);
    expect(result.verification[0].exitCode).toBe(0);
    expect(result.baseline.stdoutHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.environmentFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.cleanupSucceeded).toBe(true);
    const create = process.calls.find((call) => call.args[0] === "create");
    expect(create?.args).toContain("--network");
    expect(create?.args).toContain("none");
    expect(process.calls.some((call) => call.args.includes("-v") || call.args.includes("--volume"))).toBe(false);
    const applyCalls = process.calls.filter((call) => call.args.includes("apply"));
    expect(applyCalls).toHaveLength(2);
    expect(applyCalls.filter((call) => !call.args.includes("--check"))).toHaveLength(1);
    expect(applyCalls.find((call) => !call.args.includes("--check"))?.args).toContain("/tmp/rift-candidate.patch");
    expect(process.calls.some((call) => call.args[0] === "rm" && call.args[1] === "-f")).toBe(true);
  });

  it("fails closed when the baseline command is not allowlisted", async () => {
    const process = new FakeProcessRunner();
    const runner = new DockerSandboxRunner({ image: "rift-runner:node20", docker: process, host: process, allowedCommands: ["npm"] });

    const result = await runner.run({ repositoryPath: "/tmp/rift-fixture-checkout", candidatePatch: patch(), verificationPlan: plan("curl") });

    expect(result.verificationResult.classification).toBe("inconclusive");
    expect(result.baseline.status).toBe("blocked");
    expect(process.calls.some((call) => call.args.includes("apply"))).toBe(false);
  });

  it("classifies a failing patched fixture as regressed and preserves host files", async () => {
    const process = new FakeProcessRunner(1);
    const repositoryPath = cwd();
    const before = await readFile(`${repositoryPath}/package.json`, "utf8");
    const runner = new DockerSandboxRunner({ image: "rift-runner:node20", docker: process, host: new SpawnProcessRunner(), allowedCommands: ["npm"] });

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
    const runner = new DockerSandboxRunner({ image: "rift-runner:node20", docker: process, host: process, allowedCommands: ["npm"] });

    const result = await runner.run({ repositoryPath: "/tmp/rift-fixture-checkout", candidatePatch: patch(), verificationPlan: plan() });

    expect(result.cleanupSucceeded).toBe(false);
    expect(result.verificationResult.classification).toBe("inconclusive");
    expect(result.verificationResult.failure?.code).toBe("CLEANUP_FAILED");
  });
});
