import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Fixture suites spawn their own bounded workers; avoid host-size fan-out.
    maxWorkers: 2,
    minWorkers: 1,
  },
});
