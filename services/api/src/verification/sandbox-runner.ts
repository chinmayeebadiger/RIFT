import type { CandidatePatch, CommandSpec, VerificationPlan, VerificationResult } from "@rift/core";

export type SandboxCommandPhase = "baseline" | "verification";
export type SandboxCommandStatus = "succeeded" | "failed" | "timed-out" | "cancelled" | "blocked";

/** The observable output of one command executed inside the disposable workspace. */
export interface SandboxCommandCapture {
  readonly phase: SandboxCommandPhase;
  readonly command: CommandSpec;
  readonly status: SandboxCommandStatus;
  readonly exitCode: number | null;
  readonly stdoutHash: string;
  readonly stderrHash: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface SandboxRunResult {
  readonly verificationResult: VerificationResult;
  readonly baseline: SandboxCommandCapture;
  readonly verification: readonly SandboxCommandCapture[];
  /** Hash of the image, revision, network, and explicitly supplied environment. */
  readonly environmentFingerprint: string;
  readonly cleanupSucceeded: boolean;
}

export interface SandboxRunRequest {
  readonly repositoryPath: string;
  readonly candidatePatch: CandidatePatch;
  readonly verificationPlan: VerificationPlan;
  readonly signal?: AbortSignal;
}

/**
 * Runs one candidate patch in a disposable, policy-bounded workspace.
 * Implementations must never mount or modify the caller's repository.
 */
export interface SandboxRunner {
  run(request: SandboxRunRequest): Promise<SandboxRunResult>;
}

export class SandboxRunnerError extends Error {
  public constructor(
    message: string,
    public readonly code:
      | "INVALID_INPUT"
      | "HOST_REPOSITORY"
      | "CONTAINER"
      | "PATCH"
      | "CLEANUP"
      | "CANCELLED",
  ) {
    super(message);
    this.name = "SandboxRunnerError";
  }
}
