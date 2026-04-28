import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["tests/scenarios/**", "tests/e2e/**", "**/node_modules/**"],
    fileParallelism: false,
    globalSetup: ["./tests/setup.ts"],
    setupFiles: ["./tests/isolate.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // LanceDB native addon keeps the process alive — force exit after tests complete
    forceRerunTriggers: [],
    teardownTimeout: 5_000,
  },
});
