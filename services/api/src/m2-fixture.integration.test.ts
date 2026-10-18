import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EvidenceItem, Hypothesis, HypothesisSet, IncidentManifest, JsonValue } from "./domain/contracts.js";
import { InMemoryEvidenceStore } from "./domain/evidence-store.js";
import type { CommandSpec } from "./domain/contracts.js";
import { intakeIncidentManifest } from "./domain/intake.js";
import { sha256, withEvidenceHash } from "./domain/hashing.js";
import { validateHypothesisSet, validateIncidentManifest } from "./domain/validators.js";

const execFileAsync = promisify(execFile);
const FIXTURE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../tests/fixtures/m2-rift-shop");
const REPOSITORY_ROOT = resolve(FIXTURE_ROOT, "../../..");

interface Snapshot {
  readonly repository: string;
  readonly revision: string;
  readonly workingDirectory: string;
  readonly trackedFiles: Readonly<Record<string, string>>;
}

interface SeededDefect {
  readonly id: string;
  readonly path: string;
  readonly function: string;
  readonly invariant: string;
  readonly observation: string;
}

interface ExpectedHypothesis {
  readonly id: string;
  readonly statement: string;
  readonly supportingEvidence: readonly ("runtime-log" | "source-shop")[];
  readonly confidence: number;
  readonly nextCheck: string;
}

interface ExpectedFixture {
  readonly fixtureId: string;
  readonly expectedFailureSignature: {
    readonly name: string;
    readonly status: number;
    readonly failedTests: number;
    readonly assertionFragments: readonly string[];
  };
  readonly expectedInvestigation: {
    readonly classification: string;
    readonly uncertainty: string;
    readonly hypotheses: readonly ExpectedHypothesis[];
  };
}

interface CommandResult {
  readonly exitCode: number;
  readonly output: string;
}

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(FIXTURE_ROOT, name), "utf8")) as T;
}

function fileSha256(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(resolve(REPOSITORY_ROOT, path)).subarray()).digest("hex")}`;
}

async function runFixtureCommand(command: CommandSpec): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command.command, [...(command.args ?? [])], {
      cwd: resolve(REPOSITORY_ROOT, command.workingDirectory ?? "."),
      env: { ...process.env, CI: "1" },
      maxBuffer: 1024 * 1024,
    });
    return { exitCode: 0, output: `${result.stdout}${result.stderr}` };
  } catch (error: unknown) {
    const failure = error as { readonly code?: number | string; readonly stdout?: string; readonly stderr?: string };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
}

function appendEvidence(
  store: InMemoryEvidenceStore,
  id: string,
  content: string,
  source: { readonly type: string; readonly locator: string },
): EvidenceItem {
  return store.append(withEvidenceHash({
    schemaVersion: 1,
    kind: "EvidenceItem",
    id,
    incidentId: "RIFT-M2-RIFT-SHOP",
    correlationId: "m2-rift-shop-run",
    createdAt: "2026-10-18T12:00:00.000Z",
    capturedAt: "2026-10-18T12:00:00.000Z",
    content,
    source,
    redaction: { status: "not-required" },
    provenance: { actor: "m2-fixture-test", tool: "fixture-loader" },
  }));
}

/**
 * Test-only hypothesis seam. M2 has no production investigation engine yet;
 * this adapter makes the contract and evidence-citation expectations
 * executable without changing the engine or shared contracts.
 */
function createFixtureHypothesisOutput(
  expected: ExpectedFixture,
  evidence: Readonly<Record<string, EvidenceItem>>,
): HypothesisSet {
  const hypotheses: Hypothesis[] = expected.expectedInvestigation.hypotheses.map((expectedHypothesis) => {
    const supportingEvidenceIds = expectedHypothesis.supportingEvidence.map((key) => evidence[key].id);
    const withoutHash: Omit<Hypothesis, "contentHash"> = {
      schemaVersion: 1,
      kind: "Hypothesis",
      id: expectedHypothesis.id,
      incidentId: "RIFT-M2-RIFT-SHOP",
      correlationId: "m2-rift-shop-run",
      createdAt: "2026-10-18T12:00:00.000Z",
      statement: expectedHypothesis.statement,
      status: "open",
      confidence: expectedHypothesis.confidence,
      supportingEvidenceIds,
      contradictingEvidenceIds: [],
      assumptions: ["The checked-out repository matches the pinned baseline snapshot."],
      nextCheck: expectedHypothesis.nextCheck,
    };
    return { ...withoutHash, contentHash: sha256(withoutHash as unknown as JsonValue) };
  });

  const withoutHash: Omit<HypothesisSet, "contentHash"> = {
    schemaVersion: 1,
    kind: "HypothesisSet",
    id: "m2-hypotheses-rift-shop",
    incidentId: "RIFT-M2-RIFT-SHOP",
    correlationId: "m2-rift-shop-run",
    createdAt: "2026-10-18T12:00:00.000Z",
    hypotheses,
    rankingMethod: "fixture-declared confidence after baseline reproduction",
  };
  return { ...withoutHash, contentHash: sha256(withoutHash as unknown as JsonValue) };
}

describe("M2 Rift Shop fixture", () => {
  it("pins the baseline snapshot and its four seeded defects", () => {
    const snapshot = readFixture<Snapshot>("snapshot.json");
    const defects = readFixture<{ readonly defects: readonly SeededDefect[] }>("seeded-defects.json");
    const manifest = readFixture<IncidentManifest>("manifest.json");

    expect(manifest.repositoryRevision).toEqual({ repository: snapshot.repository, revision: snapshot.revision });
    expect(manifest.allowedPaths).toEqual(expect.arrayContaining(Object.keys(snapshot.trackedFiles)));
    for (const [path, expectedHash] of Object.entries(snapshot.trackedFiles)) {
      expect(fileSha256(path), path).toBe(expectedHash);
    }

    const source = readFileSync(resolve(REPOSITORY_ROOT, "demo/src/domain/shop.ts"), "utf8");
    expect(defects.defects).toHaveLength(4);
    for (const defect of defects.defects) {
      expect(source, defect.id).toContain(defect.id);
      expect(source, defect.function).toContain(`function ${defect.function}`);
    }
  });

  it("intakes the fixture, reproduces the unpatched baseline, and cites evidence in hypothesis output", async () => {
    const manifest = readFixture<Record<string, unknown>>("manifest.json");
    const expected = readFixture<ExpectedFixture>("expected.json");
    const runtimeLog = readFileSync(resolve(FIXTURE_ROOT, "logs/shop-api.log"), "utf8");
    const expectedRegressionLog = readFileSync(resolve(FIXTURE_ROOT, "logs/shop-regression.log"), "utf8");
    const shopSource = readFileSync(resolve(REPOSITORY_ROOT, "demo/src/domain/shop.ts"), "utf8");
    const store = new InMemoryEvidenceStore();

    const intake = intakeIncidentManifest(manifest, store, { actor: "m2-fixture-loader" });
    expect(validateIncidentManifest(intake.manifest)).toEqual({ ok: true, value: intake.manifest });
    expect(intake.manifest.repositoryRevision.revision).toBe("89bea49f373a23bda2666808976e2e15d707b6e7");
    expect(store.get(intake.evidence.id)).toEqual(intake.evidence);

    const reproduction = await runFixtureCommand(intake.manifest.reproductionCommand);
    expect(reproduction.exitCode).toBe(expected.expectedFailureSignature.status);
    expect(reproduction.output).toContain("4 failed");
    for (const fragment of expected.expectedFailureSignature.assertionFragments) {
      expect(reproduction.output).toContain(fragment);
    }

    const evidence = {
      "runtime-log": appendEvidence(store, "m2-evidence-runtime-log", runtimeLog, {
        type: "application-log",
        locator: "logs/shop-api.log",
      }),
      "source-shop": appendEvidence(store, "m2-evidence-source-shop", shopSource, {
        type: "repository-source",
        locator: "demo/src/domain/shop.ts",
      }),
      "baseline-output": appendEvidence(store, "m2-evidence-baseline-output", reproduction.output, {
        type: "reproduction-output",
        locator: "npm --prefix demo test -- --run src/domain/shop.regression.test.ts",
      }),
      "regression-log": appendEvidence(store, "m2-evidence-regression-log", expectedRegressionLog, {
        type: "log",
        locator: "logs/shop-regression.log",
      }),
    };

    expect(expectedRegressionLog).toContain(`failure=${expected.expectedFailureSignature.name}`);
    expect(expectedRegressionLog).toContain(`failed=${expected.expectedFailureSignature.failedTests}`);
    expect(evidence["baseline-output"].content).toContain("4 failed");
    expect(evidence["runtime-log"].content).toContain("WELCOME10");
    expect(evidence["source-shop"].content).toContain("BUG-004");
    expect(store.list({ incidentId: "RIFT-M2-RIFT-SHOP" })).toHaveLength(5);

    const hypothesisSet = createFixtureHypothesisOutput(expected, evidence);
    const hypothesisValidation = validateHypothesisSet(hypothesisSet);
    expect(hypothesisValidation).toEqual({ ok: true, value: hypothesisSet });
    expect(hypothesisSet.hypotheses).toHaveLength(expected.expectedInvestigation.hypotheses.length);
    expect(hypothesisSet.hypotheses.every((hypothesis) => hypothesis.supportingEvidenceIds.length > 0)).toBe(true);
    for (const hypothesis of hypothesisSet.hypotheses) {
      for (const evidenceId of hypothesis.supportingEvidenceIds) {
        expect(store.get(evidenceId), `${hypothesis.id} citation`).toBeDefined();
      }
    }
    expect(expected.expectedInvestigation.uncertainty).toContain("no patch");
  }, 30_000);
});
