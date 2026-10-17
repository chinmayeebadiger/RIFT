import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("combines classes and resolves conflicting Tailwind utilities", () => {
    expect(cn("rounded-md", "px-2 py-1", "px-4")).toBe("rounded-md py-1 px-4");
  });

  it("omits conditional falsey values while retaining object classes", () => {
    expect(cn("text-sm", false, null, undefined, { "font-semibold": true, italic: false })).toBe(
      "text-sm font-semibold",
    );
  });
});
