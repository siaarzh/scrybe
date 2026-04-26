import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/scenarios/**/*.test.ts"],
    // Scenarios spawn child processes — parallelism is safe (each has its own DATA_DIR)
    fileParallelism: true,
    // Scenarios need the embedder sidecar for index commands
    globalSetup: ["./tests/setup.ts"],
    // No per-test DATA_DIR isolation from isolate.ts — each scenario manages its own sandbox
    setupFiles: [],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    teardownTimeout: 10_000,
    forceRerunTriggers: [],
  },
});
