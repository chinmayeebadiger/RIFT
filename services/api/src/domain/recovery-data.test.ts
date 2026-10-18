import { describe, expect, it } from "vitest";
import { findRecoveryData, RecoveryFixtureValidationError, validateRecoveryData } from "./recovery-data.js";

describe("read-only recovery fixtures", () => {
  it("validates the seeded RIFT-042 records through the shared core validators", () => {
    const data = findRecoveryData("RIFT-042");
    expect(data).toBeDefined();
    expect(() => validateRecoveryData(data)).not.toThrow();
  });

  it("rejects invalid fixture records before exposure", () => {
    const data = findRecoveryData("RIFT-042");
    expect(data).toBeDefined();
    const invalid = {
      ...data,
      hypothesisSet: {
        ...data!.hypothesisSet,
        hypotheses: [{ ...data!.hypothesisSet.hypotheses[0], unexpectedField: true }],
      },
    };

    expect(() => validateRecoveryData(invalid)).toThrow(RecoveryFixtureValidationError);
    try {
      validateRecoveryData(invalid);
    } catch (error) {
      expect(error).toBeInstanceOf(RecoveryFixtureValidationError);
      expect((error as RecoveryFixtureValidationError).issues).toEqual(
        expect.arrayContaining([{ path: "$.hypothesisSet.hypotheses[0].unexpectedField", code: "unknown_key" }]),
      );
    }
  });
});
